#!/usr/bin/env python3
"""The visible-skip rule, mechanism 3 (OPS_SPEC §1.3, F3): sum the junit XML of every CI
tier, print `ran N of T (P%) — not run: A fixture-cache, B direct-cache`, and fail below the
committed floor.

    python scripts/ci_coverage.py out/*.xml --census tests/ci_census.json \
        [--pin tests/ci_fixture.txt] [--collected out/collected.txt] \
        [--expect junit-pure.xml,junit-db.xml,junit-db-slow.xml,junit-a11y.xml]

Exit 1 when: any expected XML is missing; `ran` is below `ran_floor` in the census; a test
failed or errored; a skip carries the db-gate reason or any reason the census does not list;
the a11y XML has a skipped test or no tests at all. A fixture tag that differs from the one the
census was measured against is a WARNING line, not a failure. The summary is printed to stdout
and appended to $GITHUB_STEP_SUMMARY when that variable is set.

`ran` counts every pytest item that executed (passed, failed or errored). Items that were
deselected by `-m "not cache"` never reach the XML, so direct-cache = T - collected + the
collected items skipped with the cache-marker reason; T is the collected total written by the
py-pure job (`--collected`) or, failing that, `total_items` in the census.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_EXPECT = ("junit-pure.xml", "junit-db.xml", "junit-db-slow.xml", "junit-a11y.xml")
DB_GATE_PREFIX = "db marker:"


@dataclass
class Tally:
    name: str
    tests: int = 0
    passed: int = 0
    failed: int = 0
    errors: int = 0
    skipped: int = 0
    skip_reasons: dict[str, int] = field(default_factory=dict)

    @property
    def ran(self) -> int:
        return self.passed + self.failed + self.errors


def read_xml(path: Path) -> Tally:
    tally = Tally(path.name)
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as e:
        raise SystemExit(f"ci_coverage: cannot parse {path}: {e}")
    for case in root.iter("testcase"):
        tally.tests += 1
        if case.find("failure") is not None:
            tally.failed += 1
        elif case.find("error") is not None:
            tally.errors += 1
        elif (skip := case.find("skipped")) is not None:
            tally.skipped += 1
            reason = (skip.get("message") or skip.text or "").strip()
            tally.skip_reasons[reason] = tally.skip_reasons.get(reason, 0) + 1
        else:
            tally.passed += 1
    return tally


def read_collected(path: Path | None) -> int | None:
    """The last `N tests collected` line of a `pytest --collect-only -q` run."""
    if path is None or not path.is_file():
        return None
    found = re.findall(r"(?:\d+/)?(\d+) tests? collected", path.read_text(encoding="utf-8"))
    return int(found[-1]) if found else None


def read_pin_tag(path: Path | None) -> str | None:
    if path is None or not path.is_file():
        return None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("tag="):
            return line[4:].strip() or None
    return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("xml", nargs="*", type=Path, help="junit XML files of the tiers")
    ap.add_argument("--census", type=Path, required=True, help="tests/ci_census.json")
    ap.add_argument("--pin", type=Path, default=None, help="tests/ci_fixture.txt (tag WARNING)")
    ap.add_argument("--collected", type=Path, default=None, help="pytest --collect-only output")
    ap.add_argument("--expect", default=",".join(DEFAULT_EXPECT), help="XML basenames that must exist")
    args = ap.parse_args(argv)

    census = json.loads(args.census.read_text(encoding="utf-8"))
    reason_fixture = census["skip_reasons"]["fixture_cache"]
    reason_marker = census["skip_reasons"]["cache_marker"]
    floor = int(census["ran_floor"])
    failures: list[str] = []
    warnings: list[str] = []

    by_name = {p.name: p for p in args.xml}
    expected = [n for n in args.expect.split(",") if n]
    for name in expected:
        if name not in by_name:
            failures.append(f"missing XML `{name}` — its job did not upload one (failed, cancelled or timed out?)")
    tallies = {n: read_xml(p) for n, p in by_name.items() if n in expected}
    a11y = [t for n, t in tallies.items() if "a11y" in n]
    pytest_tiers = [t for n, t in tallies.items() if "a11y" not in n]

    ran = sum(t.ran for t in pytest_tiers)
    collected_xml = sum(t.tests for t in pytest_tiers)
    fixture_cache = 0
    marker_skips = 0
    for t in pytest_tiers:
        if t.failed or t.errors:
            failures.append(f"{t.name}: {t.failed} failed, {t.errors} errored")
        for reason, n in t.skip_reasons.items():
            if reason == reason_fixture:
                fixture_cache += n
            elif reason == reason_marker:
                marker_skips += n
            elif reason.startswith(DB_GATE_PREFIX):
                failures.append(f"{t.name}: {n} db-gate skip(s) — `{reason}` (F1_REQUIRE_DB=1 must exit 3 instead)")
            else:
                failures.append(f"{t.name}: {n} skip(s) with a reason the census does not list: `{reason}`")

    collected = read_collected(args.collected)
    total = int(census["total_items"])
    if collected is not None and collected != total:
        warnings.append(f"py-pure collected {collected} items but tests/ci_census.json total_items is {total} — re-measure the census (WP-2)")
        total = collected
    direct_cache = max(total - collected_xml, 0) + marker_skips
    pct = 100.0 * ran / total if total else 0.0
    line = f"ran {ran} of {total} ({pct:.1f}%) — not run: {fixture_cache} fixture-cache, {direct_cache} direct-cache"
    if ran < floor:
        failures.append(f"ran {ran} is below the committed floor {floor} (tests/ci_census.json ran_floor)")

    for t in a11y:
        if t.tests == 0:
            failures.append(f"{t.name}: no tests recorded")
        if t.skipped:
            failures.append(f"{t.name}: {t.skipped} skipped (A11Y_REQUIRE=1 forbids a skipped a11y test)")
        if t.failed or t.errors:
            failures.append(f"{t.name}: {t.failed} failed, {t.errors} errored")

    pin_tag = read_pin_tag(args.pin)
    census_tag = census.get("fixture_tag")
    if args.pin is not None and pin_tag != census_tag:
        warnings.append(f"fixture tag `{pin_tag}` differs from the one the census was measured against (`{census_tag}`)")

    out: list[str] = ["## CI coverage", "", f"**{line}**", "", "| XML | tests | ran | passed | failed | errors | skipped |", "|---|---|---|---|---|---|---|"]
    for t in tallies.values():
        out.append(f"| {t.name} | {t.tests} | {t.ran} | {t.passed} | {t.failed} | {t.errors} | {t.skipped} |")
    out.append("")
    out.append(f"floor {floor}; a11y " + ", ".join(f"{t.tests} tests / {t.skipped} skipped" for t in a11y) if a11y else f"floor {floor}; a11y: no XML")
    out += [f"- WARNING: {w}" for w in warnings]
    out += [f"- FAIL: {f}" for f in failures]
    out.append("- RESULT: " + ("FAIL" if failures else "OK"))
    text = "\n".join(out) + "\n"
    print(text, end="")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(text)
    if failures:
        print("ci_coverage: FAIL — " + "; ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
