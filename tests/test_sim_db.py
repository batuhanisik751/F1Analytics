"""db-marked tests for f1lab.sim (SIM_SPEC §3.1): schema of the sim tables, recompute_hazards, idempotency.
Every write happens inside a transaction that is rolled back."""

import numpy as np
import pytest

from f1lab import clean, derive, pace, sim

pytestmark = pytest.mark.db


def _columns(conn, table: str) -> list[str]:
    with conn.cursor() as cur:
        # table_schema='public' (2026-09-14): v1.4 added the `ask` schema, whose views
        # carry the SAME names as these tables, so an unqualified lookup returned every
        # column twice. Production db.py always qualified; this helper did not.
        cur.execute("SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = %s "
                    "ORDER BY ordinal_position", (table,))
        return [r[0] for r in cur.fetchall()]


def test_sim_tables_match_frame_columns(db_conn):
    ids = ["session_id", "assumption_set_id"]
    assert _columns(db_conn, "sim_race_params") == ids + sim.RACE_PARAM_COLUMNS
    assert _columns(db_conn, "sim_compound_params") == ids + sim.COMPOUND_PARAM_COLUMNS
    assert _columns(db_conn, "sim_driver_params") == ids + ["driver_id"] + sim.DRIVER_PARAM_COLUMNS[1:]
    assert _columns(db_conn, "sim_driver_compound") == ids + ["driver_id"] + sim.DRIVER_COMPOUND_COLUMNS[1:]
    assert _columns(db_conn, "sim_circuit_hazard") == sim.HAZARD_COLUMNS


def _insert_race_row(cur, fit: sim.SimFit, session_id: int, asid: int) -> None:
    row = fit.race_params.iloc[0].to_dict()
    cols = ["session_id", "assumption_set_id", *sim.RACE_PARAM_COLUMNS]
    vals = [session_id, asid, *[row[c] for c in sim.RACE_PARAM_COLUMNS]]
    cur.execute(f"INSERT INTO sim_race_params ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})", vals)


def test_recompute_hazards_hungary_and_idempotent(db_conn, hungary_2024):
    db_conn.rollback()
    ann = clean.annotate_laps(hungary_2024)
    fc = pace.fuel_correct(ann, hungary_2024.total_laps, lap_km=None)
    fit = sim.fit_race(fc, derive.lap_status(ann), derive.pit_stops(hungary_2024.laps),
                       clean.stint_table(hungary_2024), hungary_2024.results, int(hungary_2024.total_laps))
    try:
        with db_conn.transaction():
            with db_conn.cursor() as cur:
                cur.execute("SELECT s.session_id, e.circuit_key FROM sessions s JOIN events e USING (year, round) "
                            "WHERE s.year = 2024 AND s.round = 13 AND s.kind = 'R'")
                sid, ck = cur.fetchone()
                cur.execute("SELECT count(DISTINCT e.circuit_key) FROM sessions s JOIN events e USING (year, round) "
                            "JOIN session_ingests si USING (session_id) WHERE s.kind = 'R' "
                            "AND si.status IN ('ok', 'partial') AND e.circuit_key IS NOT NULL")
                n_circuits = cur.fetchone()[0]
                # only the inserted Hungary row feeds the pool (the whole block is rolled back below)
                cur.execute("DELETE FROM sim_race_params")
                _insert_race_row(cur, fit, sid, 1)
            n1 = sim.recompute_hazards(db_conn, 1)
            n2 = sim.recompute_hazards(db_conn, 1)
            assert n1 == n2 == n_circuits >= 1
            with db_conn.cursor() as cur:
                cur.execute("SELECT count(*), sum(sc_episodes), sum(vsc_episodes), sum(laps), max(pooled_races), "
                            "min(sc_hazard), max(sc_hazard), min(sc_start_p), max(sc_dur_mean), max(pit_loss_pooled_s) "
                            "FROM sim_circuit_hazard")
                cnt, sc, vsc, laps, pooled_races, hmin, hmax, sp, dur, plp = cur.fetchone()
                cur.execute("SELECT races, pit_loss_circuit_s, pit_loss_pooled_s, pit_loss_pooled_mad_s, "
                            "sc_pit_factor_pooled, vsc_pit_factor_pooled, assumption_set_id FROM sim_circuit_hazard "
                            "WHERE circuit_key = %s", (ck,))
                hun = cur.fetchone()
            raise _Rollback
    except _Rollback:
        pass
    assert cnt == n_circuits and pooled_races >= cnt and laps > 0 and sc >= 0 and vsc >= 0
    assert 0.0 <= hmin <= hmax < 0.1 and 0.0 <= sp <= 1.0 and dur >= 1.0
    samples = fit.race_params.iloc[0].pit_loss_samples_s
    assert hun[0] >= 1 and hun[6] == 1
    assert hun[2] == pytest.approx(float(np.median(samples))) == plp and hun[1] == pytest.approx(hun[2])
    assert hun[3] == pytest.approx(float(np.median(np.abs(np.array(samples) - np.median(samples)))))
    assert hun[4] == pytest.approx(0.86) and hun[5] == pytest.approx(0.95)   # no SC/VSC samples -> config priors


class _Rollback(Exception):
    pass


SIM_TABLES = ["sim_race_params", "sim_compound_params", "sim_driver_params", "sim_driver_compound"]


def _sim_hash(conn, session_id: int) -> str:
    """md5 over every sim_* row of the session (all columns, ordered) plus the hazard table minus recomputed_at."""
    import hashlib
    h = hashlib.md5()
    with conn.cursor() as cur:
        for t in SIM_TABLES:
            cur.execute(f"SELECT t::text FROM {t} t WHERE session_id = %s ORDER BY t::text", (session_id,))
            for (row,) in cur.fetchall():
                h.update(row.encode())
        cols = ", ".join(c for c in sim.HAZARD_COLUMNS if c != "recomputed_at")
        cur.execute(f"SELECT ({cols})::text FROM sim_circuit_hazard ORDER BY circuit_key")
        for (row,) in cur.fetchall():
            h.update(row.encode())
    conn.rollback()
    return h.hexdigest()


def test_hazard_rows(db_conn):
    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("SELECT count(DISTINCT e.circuit_key), count(*) FROM sessions s JOIN events e USING (year, round) "
                    "JOIN session_ingests si USING (session_id) WHERE s.kind = 'R' AND si.status IN ('ok', 'partial') "
                    "AND e.circuit_key IS NOT NULL")
        n_circuits, n_races = cur.fetchone()
        cur.execute("SELECT circuit_key, races, sc_hazard, vsc_hazard, sc_dur_mean, vsc_dur_mean, sc_pit_factor_pooled, "
                    "vsc_pit_factor_pooled, pit_loss_pooled_s, pooled_races, sc_start_p FROM sim_circuit_hazard")
        rows = cur.fetchall()
    db_conn.rollback()
    assert n_circuits >= 1 and len(rows) == n_circuits and len({r[0] for r in rows}) == n_circuits
    for ck, races, sc, vsc, sdur, vdur, scf, vscf, pl, pooled, sp in rows:
        assert races >= 1 and 0.002 < sc < 0.03 and 0.0 <= vsc < 0.05, ck
        assert 3 < sdur < 9 and 1 <= vdur < 9 and 0.0 <= sp <= 1.0, ck
        assert 0.6 < scf < 1.1 and 0.6 < vscf < 1.1 and 20 < pl < 25, ck
        assert pooled == n_races, ck


def test_idempotent(db_conn, dsn):
    from f1lab import ingest
    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("SELECT session_id FROM sessions WHERE year = 2024 AND round = 13 AND kind = 'R'")
        sid = cur.fetchone()[0]
    before = _sim_hash(db_conn, sid)
    assert ingest.main(["--season", "2024", "--round", "13", "--force", "--dsn", dsn, "--sleep", "0"]) == 0
    after = _sim_hash(db_conn, sid)
    assert before == after
    with db_conn.cursor() as cur:
        cur.execute("SELECT laps_fit, drivers_fit FROM sim_race_params WHERE session_id = %s", (sid,))
        assert cur.fetchone() == (1233, 20)
    db_conn.rollback()
