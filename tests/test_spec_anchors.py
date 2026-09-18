"""Spec-anchor tests for the GAPFILL_SPEC §2.3 amendments (WP-A3).

GAPFILL_SPEC §6.3's A3 row requires that "every §2.3 amendment [is] present, checked by a
spec-anchor test that greps each named section for its new sentence."  That is what this file
is: for every row of the §2.3 table that names a section of `docs/MODE2_SPEC.md` or
`docs/QUALI_SPEC.md`, it locates *that section* and asserts the amendment's load-bearing
sentence is inside it.

Two deliberate design choices:

* **Section-scoped, not file-scoped.**  A file-wide ``in`` check would pass if the sentence
  landed in the wrong section, which is exactly the failure a spec amendment can have.  Each
  anchor is searched only in the body between its heading and the next heading of the same or
  a higher level.
* **No fitted number is asserted as a bare literal where the spec disagrees with itself.**
  Where a measured value and a spec-pinned value differ (the ex-island correlation), both are
  required to appear, so the disagreement cannot be quietly resolved by deleting one of them.

These tests read documents only.  They touch no database and take milliseconds.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODE2 = ROOT / "docs" / "MODE2_SPEC.md"
QUALI = ROOT / "docs" / "QUALI_SPEC.md"

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")


def _sections(path: Path) -> list[tuple[int, str, str]]:
    """Return (level, heading_text, body) for every heading in a markdown file.

    ``body`` runs from just after the heading to the next heading of the same or a higher
    level, so a §3.2 body does not leak into §3.3 and a §3 body does contain its §3.x
    children.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    heads: list[tuple[int, int, str]] = []
    in_fence = False
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            # A `# f1lab/decomp.py` comment inside a python fence is not a heading, and
            # treating it as one truncates §7.2 at its first code comment.
            continue
        m = _HEADING.match(line)
        if m:
            heads.append((i, len(m.group(1)), m.group(2).strip()))
    out: list[tuple[int, str, str]] = []
    for n, (idx, level, text) in enumerate(heads):
        end = len(lines)
        for later_idx, later_level, _ in heads[n + 1:]:
            if later_level <= level:
                end = later_idx
                break
        out.append((level, text, "\n".join(lines[idx + 1:end])))
    return out


def section_body(path: Path, prefix: str) -> str:
    """Body of the section whose heading starts with ``prefix`` (e.g. "3.2b ")."""
    matches = [(lvl, txt, body) for lvl, txt, body in _sections(path) if txt.startswith(prefix)]
    assert matches, f"{path.name}: no section heading starting with {prefix!r}"
    assert len(matches) == 1, (
        f"{path.name}: {len(matches)} sections start with {prefix!r}: "
        f"{[t for _, t, _ in matches]}"
    )
    return matches[0][2]


def _norm(text: str) -> str:
    """Collapse whitespace so an anchor is insensitive to where a line happens to wrap.

    Leading blockquote markers are stripped first: several amendments are written as `>`
    blocks, and a sentence that wraps inside one would otherwise carry a stray `>`.
    """
    text = re.sub(r"(?m)^\s*>\s?", "", text)
    return re.sub(r"\s+", " ", text)


# --------------------------------------------------------------------------------------
# GAPFILL_SPEC §2.3, MODE2 rows.  One (section prefix, anchors) entry per table row.
# --------------------------------------------------------------------------------------

MODE2_ANCHORS: dict[str, list[str]] = {
    # §1.2 — the stratum-completeness rule, its measured cost, and R3's trap.
    "1.2 Response and centring": [
        "every row of that stratum is retained",
        "never both centre locally and drop rows",
        "+0.767 pp",
        "+0.477 pp",
        "0.176",
        "4.4",
        "0.072",
        "4.32",
        "ordinal",
        "larger",
        "0.941 passes",
    ],
    # §1.4 — the qualifying-only mobility graph.
    "1.4 How driver separates from car": [
        "qualifying rows alone",
        "72 edges",
        "4 components",
        "zero qualifying-only edges",
        "adds rows, not edges",
        "only a transfer",
    ],
    # §1.5 item 1 — now three measured skills, and a fourth response would not change it.
    "1.5 What the model cannot identify": [
        "three measured skills",
        "Adding a fourth response would not change it",
        # GAPFILL_SPEC DL-2: the sandbagging cost is a published limitation, in the list of
        # what the model cannot do, not only a caption slot.
        "a cruise from a slow lap",
        "707 driver-sessions",
        "−0.279 pp in Q1 against −0.490 pp in Q3",
        "43 % smaller in Q1",
    ],
    # §2.4 — the evidence_share warning box is amended, not repealed.
    "2.4 The per-driver identifiability diagnostic": [
        "0.501",
        "3.50",
        "a licence to use it",
        "precisely because it does not move between the two fits",
    ],
    # §3.0 correction 1 — forward pointer becomes a backward pointer to §3.2b.
    "3.0 Two corrections to the brief": [
        "joined, not replaced",
        "3.2b",
        "0.8393",
        "0.8670",
        "did not fire",
        "backward pointer",
    ],
    # §3.2 heading + status note, the "cannot subtract it" bullet, and the lifted prohibition.
    "3.2 Grid pace": [
        "v1.8 status",
        "still fitted on `grid_position`, still ships, still never called one-lap pace",
        "0.8393",
        "0.8670",
        "below the **0.95**",
        "disagreement between two shipped skills",
        "in words",
        "not computable",
        "no \"what the penalties were worth\" column",
        "lifted for the new skill ONLY",
        "3.50",
        "3.31",
        "never joins them",
        "closer together over one lap",
    ],
}

MODE2_ANCHORS.update({
    # NEW §3.2b — the whole of GAPFILL §1 lives here.
    "3.2b One-lap pace": [
        "SHIPS",
        "Qualifying pace",
        "segment only",
        "1,135",
        "0.1605",
        "0.5620",
        "0.3846",
        "3.50",
        "Monaco",
        "six candidate responses",
        "+0.767 pp",
        "Rejected",
        "707 driver-sessions",
        "-0.279 pp".replace("-", "−"),
        "-0.490 pp".replace("-", "−"),
        "43 %",
        "V5",
        "0.607",
        "~50 %",
        "rejected on price, not on principle",
        "`s_sd = 0` for every row",
        "0.7727",
        "0.8393",
        "0.8670",
        "0.8663",
        "0.653",
        "0.6216",
        "buys validity, not precision",
        "G1",
        "G2",
        "G3",
        "r = 1.000",
        "0.95",
        "sprint_one_lap",
        "10.2",
        "17 sessions is not a corpus",
        "mode2_quali_row_audit",
        "1,567",
        "NULL on every excluded row",
    ],
    # §3.3/§3.4 — pattern unchanged, two new siblings.
    "3.4 Wet weather": [
        "refusal pattern is unchanged",
        "sprint_one_lap",
        "trail_braking",
        "0.286",
        "No CHECK key is added that is not written",
        "{nSqSessions}",
    ],
    # §3.6 — the panel becomes seven rows and renders count(*).
    "3.6 What replaces the radar": [
        "SEVEN rows",
        "Qualifying pace",
        "Sprint qualifying",
        "Trail braking",
        "{nRows}",
        "{nSessions}",
        "{nSqSessions}",
        "count(*)",
        "must not hard-code a count",
    ],
})

MODE2_ANCHORS.update({
    # §6.2 DDL — skill CHECK gains three keys; mode2_fit_run gains three columns;
    # mode2_quali_row_audit added.
    "6.2 DDL": [
        "'one_lap_pace'",
        "'sprint_one_lap'",
        "'trail_braking'",
        "corr_one_lap_grid",
        "corr_one_lap_grid_ex_islands",
        "corr_one_lap_race",
        "CREATE TABLE mode2_quali_row_audit",
        "mode2_quali_row_audit_reason_check",
        "exclude_reason",
    ],
    # §6.3 frames.TABLE_COLUMNS.
    "6.3 `frames.TABLE_COLUMNS`": [
        "mode2_quali_row_audit",
        "thirteenth",
        "corr_*".replace("*", "\\*") if False else "corr_",
    ],
    # §6.5 — status keys unchanged.
    "6.5 `analytics_status` keys": [
        "status keys are unchanged",
        "no fifth is added",
        "recompute_skills",
    ],
    # §7.2 signatures.
    "7.2 Signatures": [
        "def fit_one_lap_pace(",
        "assert_grid_pace_reproduces",
        "assert_quali_islands_hold",
        "skill_correlations",
    ],
    # §7.3 constants — six added, all entering the assumption hash.
    "7.3 New `config.py` constants": [
        "MODE2_QUALI_SEGMENT",
        "MODE2_QUALI_MIN_DRIVERS",
        "MODE2_QUALI_KINDS",
        "MODE2_QUALI_REML_START",
        "MODE2_QUALI_THIN_N",
        "MODE2_GRID_RETIRE_R",
        "assumption hash",
    ],
    # §7.7 run-end budget — +0.2 s measured.
    "7.7 Run-end budget": [
        "+0.2 s",
        "one_lap_pace",
    ],
    # §8.7 captions — C-SKILL-2 amended in place, C-SKILL-5..8 added.
    "8.7 VERBATIM captions": [
        "`C-SKILL-2` — starting-grid pace. AMENDED IN PLACE",
        "never reassigned to another skill",
        "`C-SKILL-5`",
        "`C-SKILL-6`",
        "`C-SKILL-7`",
        "`C-SKILL-8`",
        "{nRows}",
        "{nCrossZero}",
        "{nQualiLaps}",
        "{corrOneLapRace}",
        "{corrOneLapGrid}",
    ],
})

QUALI_ANCHORS: dict[str, list[str]] = {
    # §0.2 — the deferral is discharged, with what it bought and what it cost.
    "0.2 Explicitly out of scope": [
        "DONE in v1.8",
        "3.2b",
        "0.8393",
        "0.8670",
        "NOT met",
        "segment-1",
    ],
    # §4.1 — one line: a display number, measured as a response (V1) and rejected.
    "4.1 Gap to pole": [
        "display number for one session",
        "V1",
        "rejected",
        "0.676",
    ],
    # §5.1.1 — executed, deviation recorded with the six-fit table, r recorded both ways.
    "5.1.1 What v1.7 does": [
        "EXECUTED",
        "segment-1 session-mean-centred percent",
        "0.8393",
        "0.8637",
        "0.8670",
        "0.8830",
        "0.7727",
        "0.8663",
        "both skills ship",
        "reported BOTH ways",
        "14 %",
        "G3",
        "99.55 %",
        "remain floating",
    ],
    # §5.2 — the boundary: first-class as a session surface, out of this one fit.
    "5.2 Sprint qualifying is first-class": [
        "first-class as a session surface",
        "excluded from the",
        "one_lap_pace",
        "10.2",
        "0.4861",
        "sprint_one_lap",
        "not a demotion",
    ],
    # §5.3.3 — GAPFILL_SPEC §2.4's "ask_answer_cache invalidated on the 0009 apply, per
    # QUALI_SPEC §5.3.3": the v1.8 regeneration's measured prefix, the executed DELETE and
    # its row count, and the fact that the committed constant in prompt.ts is a hand-off.
    "5.3.3 `ask_answer_cache` invalidation": [
        "v1.8 — this rule fired a second time",
        "4c93e88444b54de147d66283884abfe3de293e68de84b5672d5420fd4190939d",
        "matched **0 rows**",
        "PROMPT_PREFIX_SHA256",
        "live",
    ],
}


# --------------------------------------------------------------------------------------
# The tests
# --------------------------------------------------------------------------------------

def _cases(anchors: dict[str, list[str]], path: Path):
    return [(path, prefix, a) for prefix, items in anchors.items() for a in items]


@pytest.mark.parametrize(
    "path,prefix,anchor",
    _cases(MODE2_ANCHORS, MODE2),
    ids=lambda v: v if isinstance(v, str) else v.name,
)
def test_mode2_amendment_is_present_in_its_own_section(path, prefix, anchor):
    body = _norm(section_body(path, prefix))
    assert _norm(anchor) in body, (
        f"GAPFILL_SPEC §2.3 requires this sentence in {path.name} §{prefix.split()[0]}, "
        f"and it is not in that section: {anchor!r}"
    )


@pytest.mark.parametrize(
    "path,prefix,anchor",
    _cases(QUALI_ANCHORS, QUALI),
    ids=lambda v: v if isinstance(v, str) else v.name,
)
def test_quali_amendment_is_present_in_its_own_section(path, prefix, anchor):
    body = _norm(section_body(path, prefix))
    assert _norm(anchor) in body, (
        f"GAPFILL_SPEC §2.3 requires this sentence in {path.name} §{prefix.split()[0]}, "
        f"and it is not in that section: {anchor!r}"
    )


def test_every_named_section_of_2_3_is_covered():
    """The two anchor tables between them name every §2.3 row that targets a spec I own."""
    for prefix in list(MODE2_ANCHORS) + list(QUALI_ANCHORS):
        assert MODE2_ANCHORS.get(prefix) or QUALI_ANCHORS.get(prefix), prefix
    # §2.3 names these MODE2 sections; none may be dropped from the table above.
    for sec in ("1.2", "1.4", "1.5", "2.4", "3.0", "3.2", "3.2b", "3.4", "3.6",
                "6.2", "6.3", "6.5", "7.2", "7.3", "7.7", "8.7"):
        assert any(p.split()[0] == sec for p in MODE2_ANCHORS), f"MODE2 §{sec} not covered"
    for sec in ("0.2", "4.1", "5.1.1", "5.2", "5.3.3"):
        assert any(p.split()[0] == sec for p in QUALI_ANCHORS), f"QUALI §{sec} not covered"


def test_caption_id_c_skill_2_is_still_the_grid_pace_caption():
    """DL-12: caption IDs are never reassigned.  C-SKILL-2 stays attached to grid pace."""
    body = _norm(section_body(MODE2, "8.7 VERBATIM captions"))
    i = body.index("`C-SKILL-2`")
    head = body[i:i + 200]
    assert "starting-grid pace" in head.lower(), head
    assert "qualifying pace" not in head.lower().split("amended")[0], head


def test_the_measured_ex_island_correlation_and_the_pinned_one_are_both_recorded():
    """WP-A1 measures 0.8663; GAPFILL_SPEC pins 0.8670.  Neither is adjusted to agree, so
    both must survive in the two places the disagreement is recorded."""
    for path, prefix in ((MODE2, "3.2b One-lap pace"), (QUALI, "5.1.1 What v1.7 does")):
        body = _norm(section_body(path, prefix))
        assert "0.8670" in body and "0.8663" in body, (
            f"{path.name} §{prefix.split()[0]} must record BOTH the spec-pinned 0.8670 and the "
            "measured 0.8663; adjusting either to agree is forbidden"
        )


def test_no_spec_i_own_still_claims_there_are_no_qualifying_sessions():
    """QUALI_SPEC §5.3.3's definition of done, applied to the two documents I own."""
    # QUALI_SPEC §5.3.3's grep, verbatim: a case-insensitive phrase and a shouted one.
    bad = re.compile(r"(?i:no qualifying sessions)|NO QUALIFYING")
    for path in (MODE2, QUALI):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not bad.search(line):
                continue
            # Legal in exactly two places: a sentence explicitly marked as historical, and
            # an amendment row quoting the old sentence in order to replace it.
            historical = "were no" in line or "v1.3" in line or "when this spec was" in line
            # QUALI_SPEC §5.3.3 spells out the grep itself; that occurrence is the rule, not
            # a violation of it.
            historical = historical or "grep -r" in line
            # An amendment row quotes the old sentence so it can be replaced: the phrase sits
            # inside double quotes, on a "→" line or in a `|`-delimited amendment table row.
            quoted = bool(re.search(r'"[^"]*(?i:no qualifying sessions)[^"]*"', line))
            quoted_for_replacement = quoted and ("→" in line or line.lstrip().startswith("|"))
            assert historical or quoted_for_replacement, f"{path.name}:{n}: {line.strip()}"
