"""Team and compound colours and teammate line styles, resolved at ingest time.

The web app never imports FastF1 and never hard-codes a team colour, so every hex
value it shows was decided here and stored in the database together with where it
came from (``'fastf1'`` | ``'results'`` | ``'fallback'``). All hex values are
lowercase ``#rrggbb``.
"""

from __future__ import annotations

import re

import fastf1.plotting as f1plot

FALLBACK_TEAM_COLOUR = "#e8a33d"

# FastF1 wins where present; this fills the gaps (and the compounds FastF1 does not know).
COMPOUND_FALLBACK: dict[str, str] = {
    "SOFT": "#e8474b",
    "MEDIUM": "#e8c547",
    "HARD": "#ede6dc",
    "INTERMEDIATE": "#4baa5e",
    "WET": "#3c7fd6",
    "UNKNOWN": "#7a736b",
    "TEST-UNKNOWN": "#434649",
}

LINE_STYLES = ("solid", "dashed", "dotted")

_HEX6 = re.compile(r"^[0-9a-fA-F]{6}$")


def _normalise_hex(value: object) -> str | None:
    """'#FF8000' / 'FF8000' -> '#ff8000'; anything else -> None."""
    if not isinstance(value, str):
        return None
    v = value.strip().lstrip("#")
    if not _HEX6.match(v):
        return None
    return "#" + v.lower()


def team_colour(team_name: str, session, team_color_hex: object = None) -> tuple[str, str]:
    """``(hex, source)`` for a team as it was in this session.

    Chain: ``fastf1.plotting.get_team_color(team_name, session=session)`` →
    ``results.TeamColor`` (6 hex chars, no '#') → the accent fallback.
    """
    try:
        hx = _normalise_hex(f1plot.get_team_color(team_name, session=session))
        if hx is not None:
            return hx, "fastf1"
    except Exception:  # noqa: BLE001  (unknown team name, missing plotting data)
        pass
    hx = _normalise_hex(team_color_hex)
    if hx is not None:
        return hx, "results"
    return FALLBACK_TEAM_COLOUR, "fallback"


def compound_colours(session, seen) -> dict[str, str]:
    """Colour per compound: FastF1's mapping merged OVER the fallback map.

    Restricted to the union of FastF1's keys and the compounds actually seen in the
    session's laps, so every compound present in ``laps`` has a row and nothing
    irrelevant is stored. A seen compound unknown to both maps gets the UNKNOWN colour.
    """
    mapping: dict[str, str] = {}
    try:
        raw = f1plot.get_compound_mapping(session=session)
        for k, v in dict(raw).items():
            hx = _normalise_hex(v)
            if hx is not None:
                mapping[str(k).upper()] = hx
    except Exception:  # noqa: BLE001
        mapping = {}

    merged = dict(COMPOUND_FALLBACK)
    merged.update(mapping)

    keys = set(mapping) | {str(c).upper() for c in seen if isinstance(c, str) and c and c != "nan"}
    return {k: merged.get(k, COMPOUND_FALLBACK["UNKNOWN"]) for k in sorted(keys)}


def line_style(code: str, session, number_rank: int) -> tuple[str, str]:
    """``(style, source)`` for a driver: FastF1's teammate convention, else by car number.

    ``number_rank`` is the driver's 0-based rank among their teammates by
    ``int(driver_number)`` ascending: 0 → 'solid', 1 → 'dashed', 2+ → 'dotted'.
    """
    try:
        style = f1plot.get_driver_style(code, style=["linestyle"], session=session)["linestyle"]
        if isinstance(style, str) and style in LINE_STYLES:
            return style, "fastf1"
    except Exception:  # noqa: BLE001
        pass
    rank = max(0, int(number_rank))
    return LINE_STYLES[min(rank, 2)], "fallback"
