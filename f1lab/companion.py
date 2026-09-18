"""The run-end companion orchestrator (MODE1_SPEC §6.5).

Three of the four v1.2 features are cross-race artifacts: what they compute depends on
which *other* races exist, which is exactly the property ``sim.recompute_hazards``
already handles with a run-end step. They run here, in a fixed order, after the
per-session frames and after ``season.recompute``:

    sessions -> per-session frames -> sim.recompute_hazards -> season.recompute (incl. title)
             -> companion.recompute_companion (winprob, odi, preview, mode2, report)

``mode2`` (MODE2_SPEC §7.4) runs **last**, after ``preview``: the driver-vs-car
decomposition is entirely cross-race and reads ``sim_driver_params`` plus
``driver_standings`` and ``title``'s fitted Plackett-Luce, so a per-session hook would
be wrong as well as slow. It is the only step that reads ``force`` (§7.8).

The fourth, ``title_*``, is genuinely per-season and is called from ``season.recompute``
instead, so the season page's odds and its standings are computed in one transaction.

``report`` (MODE3_SPEC §4.4) is v1.4's addition and runs **after mode2**, i.e. last. It
reads ``wp_swing``, so any earlier position would have it narrate the previous model
generation's swings. It is also the only step that calls a network API other than FastF1:
with no ``ANTHROPIC_API_KEY`` it writes nothing, logs ``report: skipped (no key)`` and
returns zero counts, because an ingest without a key must still succeed (§4.6).
"""

from __future__ import annotations

import logging

from . import decomp, preview, report, winprob

log = logging.getLogger(__name__)

# MODE3_SPEC §4.4 — `report` runs LAST. It reads `wp_swing`, so running it before the
# winprob step would have it describe the previous model generation's swings as if they
# were this run's. It is also the only step that makes a network call, and the only one
# that is allowed to do nothing at all: with no ANTHROPIC_API_KEY it skips and the ingest
# still exits 0 (§4.6).
STEPS: tuple[str, ...] = ("winprob", "odi", "preview", "mode2", "report")


class CompanionInputsMissing(RuntimeError):
    """A prerequisite of the run-end step is not in the database yet."""


def parse_steps(spec: str | None) -> tuple[str, ...]:
    """``"all"`` / ``None`` -> every step; otherwise a comma list, in STEPS order."""
    if spec is None or spec.strip() in ("", "all"):
        return STEPS
    wanted = {s.strip() for s in spec.split(",") if s.strip()}
    if "all" in wanted:
        return STEPS
    unknown = sorted(wanted - set(STEPS))
    if unknown:
        raise ValueError(f"unknown companion step(s) {unknown}; choose from {list(STEPS)} or 'all'")
    return tuple(s for s in STEPS if s in wanted)


def assert_inputs(conn) -> None:
    """Fail loudly and early if the fixed ordering of §6.5 was not honoured."""
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM sim_circuit_hazard")
        if int(cur.fetchone()[0]) == 0:
            raise CompanionInputsMissing(
                "sim_circuit_hazard is empty: run sim.recompute_hazards before the companion step")
        cur.execute("SELECT count(*) FROM driver_standings")
        if int(cur.fetchone()[0]) == 0:
            raise CompanionInputsMissing(
                "driver_standings is empty: run season.recompute before the companion step")
        # MODE2_SPEC §7.4: the decomposition's observation unit is v1.1's per-race
        # sim_driver_params.base_s, so the per-session sim step must have run first.
        cur.execute("SELECT count(*) FROM sim_driver_params")
        if int(cur.fetchone()[0]) == 0:
            raise CompanionInputsMissing(
                "sim_driver_params is empty: run the per-session sim step before mode2")


def recompute_companion(conn, assumption_set_id: int, *,
                        steps: tuple[str, ...] = STEPS,
                        force: bool = False,
                        regen_reports: bool = False) -> dict[str, dict]:
    """Run the run-end companion steps from stored rows. No FastF1 loads.

    ``force`` is passed through from ``ingest --force``; only the ``mode2`` step reads
    it (to refit instead of returning early on an unchanged ``model_version``, §6.6).
    The others ignore it exactly as they do today — including ``report``, deliberately:
    §4.5 requires ``ingest --force`` to regenerate ZERO reports when the numbers are
    unchanged, so a forced ingest must not become a forced spend.

    ``regen_reports`` is ``ingest --regen-reports`` and is read only by the ``report``
    step. It is the prompt-change flag: it bypasses the ``grounding_sha256`` check and
    re-calls the model for every race, which costs real money (§4.5).

    Returns ``{step: counts}`` for each step that ran.
    """
    asid = int(assumption_set_id)
    assert_inputs(conn)
    out: dict[str, dict] = {}
    for step in STEPS:
        if step not in steps:
            continue
        if step == "winprob":
            out["winprob"] = winprob.recompute_winprob(conn, asid)
        elif step == "odi":
            out["odi"] = {"circuit_odi": int(preview.recompute_odi(conn, asid))}
        elif step == "preview":
            out["preview"] = preview.recompute_preview(conn, asid)
        elif step == "mode2":
            out["mode2"] = decomp.recompute_all(conn, asid, force=force)
        elif step == "report":
            # §4.5 — idempotent on `grounding_sha256`: `--force` regenerates ZERO reports when
            # the numbers are unchanged, so `force` is deliberately NOT passed through as a
            # reason to re-call the model. `--regen-reports` is the separate flag for a prompt
            # change and is the only thing that bypasses the hash.
            # commit=False: ingest.py wraps every companion step in `with _committed(conn)`,
            # and psycopg3 forbids an explicit commit() inside a Transaction context.
            out["report"] = report.recompute_reports(
                conn, asid, regen=regen_reports, commit=False)
        log.info("companion step %s: %s", step, out[step])
    return out
