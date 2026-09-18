"""Pre-fetch FastF1 data for every completed race in the given seasons.

The network pull is the slow part of ingest — roughly a minute per race — and it
only ever needs to happen once. Running this ahead of time means the real ingest
reads everything from cache/ and finishes in seconds per race.

Usage:  .venv/bin/python scripts/warm_cache.py 2025 2026
        .venv/bin/python scripts/warm_cache.py --sprints 2025 2026   # also the Sprint sessions
        .venv/bin/python scripts/warm_cache.py --quali 2024 2025 2026 # also Q and Sprint Qualifying

Sprint sessions are ingested too (results only), so warming them saves the
~12 small uncached loads per season that ingest would otherwise do itself.
"""

from __future__ import annotations

import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

import fastf1  # noqa: E402
from fastf1.logger import set_log_level  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
fastf1.Cache.enable_cache(ROOT / "cache")
set_log_level("ERROR")


def completed_rounds(year: int) -> list[tuple[int, str, bool]]:
    """(round, name, has_sprint) for every round whose race Sunday is in the past."""
    sched = fastf1.get_event_schedule(year, include_testing=False)
    now = datetime.now(timezone.utc)
    out = []
    for _, ev in sched.iterrows():
        # EventDate is the Sunday; anything before now has a race to load.
        date = ev["EventDate"]
        if date.tzinfo is None:
            date = date.tz_localize("UTC")
        if date < now:
            out.append((int(ev["RoundNumber"]), str(ev["EventName"]),
                        str(ev["EventFormat"]) == "sprint_qualifying"))
    return out


def main(years: list[int], sprints: bool = False, quali: bool = False) -> None:
    for year in years:
        rounds = completed_rounds(year)
        print(f"== {year}: {len(rounds)} completed rounds", flush=True)
        for rnd, name, has_sprint in rounds:
            kinds = ["R"] + (["S"] if sprints and has_sprint else [])
            if quali:
                # 'Q' is the grid-setting session on every weekend; 'SQ' sets the sprint
                # grid and exists only on sprint_qualifying weekends (FastF1 names it
                # "Sprint Qualifying"). Both are separate loads from the race.
                kinds += ["Q"] + (["SQ"] if has_sprint else [])
            for kind in kinds:
                try:
                    s = fastf1.get_session(year, rnd, kind)
                    s.load(telemetry=False, weather=True, messages=True)
                    print(f"  ok   {year} R{rnd:02d} {kind} {name}  laps={len(s.laps)}", flush=True)
                except Exception as e:  # noqa: BLE001
                    print(f"  FAIL {year} R{rnd:02d} {kind} {name}: {type(e).__name__}: {e}", flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    args = sys.argv[1:]
    want_sprints = "--sprints" in args
    want_quali = "--quali" in args
    years = [int(y) for y in args if not y.startswith("--")]
    main(years or [2025, 2026], sprints=want_sprints, quali=want_quali)
