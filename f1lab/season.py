"""Season aggregates, recomputed from Postgres alone (never from FastF1).

``recompute(conn, year)`` reads the per-session tables for one year and, in one
transaction, rewrites ``driver_standings``, ``constructor_standings``,
``driver_season_summary``, ``teammate_h2h`` and ``season_quali_h2h`` for that year
and refreshes the
aggregate columns of ``seasons``. Definitions are in docs/SPEC.md §1.8 / §2.6:

- a round counts only if its race session's ingest status is 'ok' or 'partial';
- points = race + sprint points; wins/podiums = race sessions only;
- standings order: points desc, then full countback (P1 count, P2 count, ... P20,
  classified rows only), then id asc;
- one standings snapshot per after_round in 1..standings_after_round, even for
  rounds that contributed nothing.
"""

from __future__ import annotations

import datetime as dt

import pandas as pd
from psycopg import sql

from . import assumptions, frames, title

COUNTBACK_POSITIONS = 20

QUALI_KINDS = ("Q", "SQ")

#: Minimum sessions before the web layer may show the season delta ungreyed (§4.3 rule 3).
QUALI_MIN_SESSIONS = 5


def _is_caveated(warnings) -> bool:
    """§4.6 / §4.3: a qualifying session is caveated when its segments are not comparable
    (``cross_segment_ok`` false) or its segment assignment needed a bounded repair.

    Read from ``session_ingests.warnings[]``, which is where the ingest records both
    (``quali_cross_segment_ok=<bool>`` and ``quali_segment_repairs=<n>``); there is no
    column for either fact in v1.6.
    """
    for w in (warnings or ()):
        w = str(w)
        if w == "quali_cross_segment_ok=False":
            return True
        if w.startswith("quali_segment_repairs="):
            try:
                if int(w.split("=", 1)[1]) > 0:
                    return True
            except ValueError:
                pass
    return False




def _read(conn, query: str, params: tuple = ()) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(query, params)
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def _is_classified(cp: pd.Series) -> pd.Series:
    return cp.astype(str).str.fullmatch(r"\d+")


def _countback(pos: pd.Series) -> tuple:
    """(-count of P1s, -count of P2s, ...) so that a plain ascending sort ranks better first."""
    counts = pos.value_counts()
    return tuple(-int(counts.get(p, 0)) for p in range(1, COUNTBACK_POSITIONS + 1))


def _order(df: pd.DataFrame, id_col: str, points_col: str, countbacks: dict) -> pd.DataFrame:
    """Sort by points desc, countback, id asc and number positions from 1."""
    if df.empty:
        return df.assign(position=pd.Series(dtype=int))
    no_results = tuple([0] * COUNTBACK_POSITIONS)
    keys = [(-float(p), countbacks.get(i, no_results), str(i))
            for p, i in zip(df[points_col], df[id_col])]
    order = sorted(range(len(df)), key=lambda k: keys[k])
    out = df.iloc[order].reset_index(drop=True)
    out["position"] = range(1, len(out) + 1)
    return out


class _SeasonData:
    """Everything recompute() needs, read once."""

    def __init__(self, conn, year: int):
        self.year = year
        self.sessions = _read(conn, """
            SELECT s.session_id, s.round, s.kind, si.status, si.assumption_set_id
            FROM sessions s LEFT JOIN session_ingests si ON si.session_id = s.session_id
            WHERE s.year = %s ORDER BY s.round, s.kind""", (year,))
        ok = self.sessions[self.sessions["status"].isin(["ok", "partial"])]
        self.race_ok = ok[ok["kind"] == "R"].copy()
        self.sprint_ok = self.sessions[(self.sessions["kind"] == "S") & (self.sessions["status"] == "ok")].copy()
        self.included = pd.concat([self.race_ok, self.sprint_ok], ignore_index=True)
        ids = tuple(int(x) for x in self.included["session_id"]) or (-1,)

        self.entries = _read(conn, "SELECT session_id, driver_id, team_id, code FROM session_entries "
                                   "WHERE session_id = ANY(%s)", (list(ids),))
        self.teams = _read(conn, "SELECT session_id, team_id, team_name, colour FROM session_teams "
                                 "WHERE session_id = ANY(%s)", (list(ids),))
        self.results = _read(conn, "SELECT session_id, driver_id, position, classified_position, grid_position, "
                                   "points, status FROM results WHERE session_id = ANY(%s)", (list(ids),))
        self.pace = _read(conn, "SELECT session_id, driver_id, rank, team_id, median_pace_s FROM pace_ranking "
                                "WHERE session_id = ANY(%s)", (list(ids),))
        self.deltas = _read(conn, "SELECT session_id, team_id, faster_driver_id, slower_driver_id, gap_s, gap_pct, "
                                  "laps_compared FROM teammate_deltas WHERE session_id = ANY(%s)", (list(ids),))

        meta = self.included[["session_id", "round", "kind"]]
        self.results = self.results.merge(meta, on="session_id", how="inner")
        self.results["points"] = self.results["points"].astype(float).fillna(0.0)
        self.results["classified"] = _is_classified(self.results["classified_position"])
        self.entries = self.entries.merge(meta, on="session_id", how="inner")
        self.entries = self.entries.merge(self.teams, on=["session_id", "team_id"], how="left")
        self.pace = self.pace.merge(meta, on="session_id", how="inner")
        self.deltas = self.deltas.merge(meta, on="session_id", how="inner")

        self.standings_after_round = int(self.race_ok["round"].max()) if len(self.race_ok) else None
        sets = self.race_ok["assumption_set_id"].dropna().unique().tolist()
        self.mixed = len(sets) > 1
        self.assumption_set_id = int(sets[0]) if len(sets) == 1 else None
        self.has_sprint_results = bool(len(self.sprint_ok))

        # -- qualifying (QUALI_SPEC v1.6 §3.6 / §4.3) --------------------------------------
        # Q and SQ are read separately from the race/sprint set above and are NEVER pooled:
        # ``kind`` is part of season_quali_h2h's primary key (§5.2).
        q = self.sessions[self.sessions["kind"].isin(QUALI_KINDS)
                          & self.sessions["status"].isin(["ok", "partial"])].copy()
        self.quali_ok = q
        qids = [int(x) for x in q["session_id"]] or [-1]
        self.quali_results = _read(conn, "SELECT session_id, driver_id, team_id, position "
                                         "FROM quali_results WHERE session_id = ANY(%s)", (qids,))
        self.quali_pairs = _read(conn, "SELECT session_id, team_id, driver_a, driver_b, delta_s, "
                                       "delta_pct, comparable FROM quali_teammate_h2h "
                                       "WHERE session_id = ANY(%s)", (qids,))
        warn = _read(conn, "SELECT session_id, warnings FROM session_ingests WHERE session_id = ANY(%s)", (qids,))
        self.quali_caveated = {int(r.session_id) for r in warn.itertuples()
                               if _is_caveated(r.warnings)}
        qmeta = q[["session_id", "kind"]]
        self.quali_results = self.quali_results.merge(qmeta, on="session_id", how="inner")
        self.quali_pairs = self.quali_pairs.merge(qmeta, on="session_id", how="inner")

    # -- helpers ------------------------------------------------------------------------------

    def latest_race_team(self, upto_round: int) -> pd.DataFrame:
        """driver_id -> (team_id, team_name, colour) of the driver's latest race session <= round."""
        e = self.entries[(self.entries["kind"] == "R") & (self.entries["round"] <= upto_round)]
        e = e.sort_values("round").drop_duplicates("driver_id", keep="last")
        return e.set_index("driver_id")[["team_id", "team_name", "colour"]]

    def latest_team_row(self, upto_round: int) -> pd.DataFrame:
        """team_id -> (team_name, colour) from the latest race session <= round where the team appears."""
        t = self.teams.merge(self.included[["session_id", "round", "kind"]], on="session_id")
        t = t[(t["kind"] == "R") & (t["round"] <= upto_round)].sort_values("round")
        t = t.drop_duplicates("team_id", keep="last")
        return t.set_index("team_id")[["team_name", "colour"]]


def _driver_standings(d: _SeasonData, after_round: int) -> pd.DataFrame:
    res = d.results[d.results["round"] <= after_round]
    race = res[res["kind"] == "R"]
    sprint = res[res["kind"] == "S"]
    drivers = sorted(set(res["driver_id"]))
    if not drivers:
        return pd.DataFrame(columns=frames.EXPECTED_COLUMNS["driver_standings"])

    teams = d.latest_race_team(after_round)
    classified = race[race["classified"]]
    countbacks = {drv: _countback(grp["position"]) for drv, grp in classified.groupby("driver_id")}

    rows = []
    for drv in drivers:
        r = race[race["driver_id"] == drv]
        s = sprint[sprint["driver_id"] == drv]
        # A driver who only appears in a sprint has no race team yet; fall back to any entry.
        if drv in teams.index:
            team = teams.loc[drv]
        else:
            e = d.entries[(d.entries["driver_id"] == drv) & (d.entries["round"] <= after_round)]
            team = e.sort_values("round").iloc[-1][["team_id", "team_name", "colour"]]
        rows.append({
            "year": d.year, "after_round": after_round, "driver_id": drv,
            "team_id": team["team_id"], "team_name": team["team_name"], "team_colour": team["colour"],
            "points": float(r["points"].sum() + s["points"].sum()),
            "sprint_points": float(s["points"].sum()),
            "wins": int((r["position"] == 1).sum()),
            "podiums": int(r["position"].le(3).sum()),
            "races": int(len(r)),
        })
    df = _order(pd.DataFrame(rows), "driver_id", "points", countbacks)
    return df[frames.EXPECTED_COLUMNS["driver_standings"]]


def _constructor_standings(d: _SeasonData, after_round: int) -> pd.DataFrame:
    res = d.results[d.results["round"] <= after_round].merge(
        d.entries[["session_id", "driver_id", "team_id"]], on=["session_id", "driver_id"], how="left")
    if res.empty:
        return pd.DataFrame(columns=frames.EXPECTED_COLUMNS["constructor_standings"])
    race = res[res["kind"] == "R"]
    names = d.latest_team_row(after_round)
    classified = race[race["classified"]]
    countbacks = {t: _countback(grp["position"]) for t, grp in classified.groupby("team_id")}

    rows = []
    for team_id, grp in res.groupby("team_id"):
        r = race[race["team_id"] == team_id]
        if team_id in names.index:
            name, colour = names.loc[team_id, "team_name"], names.loc[team_id, "colour"]
        else:
            t = d.teams[d.teams["team_id"] == team_id].iloc[-1]
            name, colour = t["team_name"], t["colour"]
        rows.append({
            "year": d.year, "after_round": after_round, "team_id": team_id, "team_name": name,
            "team_colour": colour, "points": float(grp["points"].sum()),
            "wins": int((r["position"] == 1).sum()), "podiums": int(r["position"].le(3).sum()),
        })
    df = _order(pd.DataFrame(rows), "team_id", "points", countbacks)
    return df[frames.EXPECTED_COLUMNS["constructor_standings"]]


def _driver_season_summary(d: _SeasonData, standings: pd.DataFrame) -> pd.DataFrame:
    race = d.results[d.results["kind"] == "R"]
    if race.empty or d.standings_after_round is None:
        return pd.DataFrame(columns=frames.EXPECTED_COLUMNS["driver_season_summary"])
    sprint = d.results[d.results["kind"] == "S"]
    teams = d.latest_race_team(d.standings_after_round)
    final = standings[standings["after_round"] == d.standings_after_round].set_index("driver_id")["position"]
    asid = None if d.mixed else d.assumption_set_id

    rows = []
    for drv, r in race.groupby("driver_id"):
        s = sprint[sprint["driver_id"] == drv]
        cls = r[r["classified"]]
        grid = r[r["grid_position"].fillna(0) > 0]["grid_position"]
        pr = d.pace[d.pace["driver_id"] == drv]
        team = teams.loc[drv]
        rows.append({
            "year": d.year, "driver_id": drv, "assumption_set_id": asid,
            "team_id": team["team_id"], "team_name": team["team_name"], "team_colour": team["colour"],
            "races": int(len(r)), "points": float(r["points"].sum() + s["points"].sum()),
            "wins": int((r["position"] == 1).sum()), "podiums": int(r["position"].le(3).sum()),
            "dnfs": int((~r["classified"]).sum()),
            "championship_position": int(final[drv]) if drv in final.index else None,
            "best_finish": int(cls["position"].min()) if len(cls) and cls["position"].notna().any() else None,
            "avg_finish": float(cls["position"].mean()) if len(cls) and cls["position"].notna().any() else None,
            "avg_grid": float(grid.mean()) if len(grid) else None,
            "mean_pace_rank": float(pr["rank"].mean()) if len(pr) else None,
            "races_ranked": int(len(pr)),
        })
    return pd.DataFrame(rows, columns=frames.EXPECTED_COLUMNS["driver_season_summary"])


def _teammate_h2h(d: _SeasonData) -> pd.DataFrame:
    entries = d.entries[d.entries["kind"] == "R"]
    if entries.empty:
        return pd.DataFrame(columns=frames.EXPECTED_COLUMNS["teammate_h2h"])
    race = d.results[d.results["kind"] == "R"].set_index(["session_id", "driver_id"])
    asid = None if d.mixed else d.assumption_set_id

    # Every (driver, teammate, session, team) where both were entered for that team.
    pairs = []
    for (sid, team_id), grp in entries.groupby(["session_id", "team_id"]):
        drivers = sorted(grp["driver_id"])
        rnd = int(grp["round"].iloc[0])
        for a in drivers:
            for b in drivers:
                if a != b:
                    pairs.append((a, b, sid, team_id, rnd))
    if not pairs:
        return pd.DataFrame(columns=frames.EXPECTED_COLUMNS["teammate_h2h"])
    pairs = pd.DataFrame(pairs, columns=["driver_id", "teammate_driver_id", "session_id", "team_id", "round"])

    rows = []
    for (a, b), grp in pairs.groupby(["driver_id", "teammate_driver_id"]):
        team_id = grp.sort_values("round")["team_id"].iloc[-1]
        sids = set(grp["session_id"])
        dl = d.deltas[d.deltas["session_id"].isin(sids)]
        wins = dl[(dl["faster_driver_id"] == a) & (dl["slower_driver_id"] == b)]
        losses = dl[(dl["faster_driver_id"] == b) & (dl["slower_driver_id"] == a)]
        signed = pd.concat([wins["gap_pct"].astype(float), -losses["gap_pct"].astype(float)])

        fw = fl = gw = gl = 0
        pf = pa = 0.0
        for sid in sids:
            if (sid, a) not in race.index or (sid, b) not in race.index:
                continue
            ra, rb = race.loc[(sid, a)], race.loc[(sid, b)]
            pf += float(ra["points"]); pa += float(rb["points"])
            if ra["classified"] and rb["classified"] and pd.notna(ra["position"]) and pd.notna(rb["position"]):
                if ra["position"] < rb["position"]:
                    fw += 1
                elif rb["position"] < ra["position"]:
                    fl += 1
            ga, gb = ra["grid_position"], rb["grid_position"]
            if pd.notna(ga) and pd.notna(gb) and ga > 0 and gb > 0:
                if ga < gb:
                    gw += 1
                elif gb < ga:
                    gl += 1
        rows.append({
            "year": d.year, "driver_id": a, "teammate_driver_id": b, "assumption_set_id": asid,
            "team_id": team_id, "races_paired": int(len(sids)),
            "pace_wins": int(len(wins)), "pace_losses": int(len(losses)),
            "mean_signed_gap_pct": float(signed.mean()) if len(signed) else None,
            "median_signed_gap_pct": float(signed.median()) if len(signed) else None,
            "finish_wins": fw, "finish_losses": fl, "grid_wins": gw, "grid_losses": gl,
            "points_for": pf, "points_against": pa,
        })
    return pd.DataFrame(rows, columns=frames.EXPECTED_COLUMNS["teammate_h2h"])


def _season_quali_h2h(d: _SeasonData) -> pd.DataFrame:
    """QUALI_SPEC §3.6 / §4.3 -- one row per (year, kind, team_id, driver pair).

    Wins come from the official classification (``quali_results.position``), so a session
    whose per-segment analytics were suppressed by D8's runtime anchor gate still counts.
    Deltas come from ``quali_teammate_h2h`` and only from rows with ``comparable = true``:
    a driver who crashed out of Q1 keeps his loss but leaves the median (§4.3's
    non-random missingness). Median and MAD, never mean and SD -- one wet session can move
    a mean by 3% (§3.6).
    """
    cols = frames.EXPECTED_COLUMNS["season_quali_h2h"]
    if d.quali_results.empty:
        return pd.DataFrame(columns=cols)

    # (session, team, unordered pair) -> (quicker driver, delta_s > 0, delta_pct > 0)
    deltas: dict[tuple, tuple] = {}
    for r in d.quali_pairs.itertuples():
        if not bool(r.comparable) or pd.isna(r.delta_s) or pd.isna(r.delta_pct):
            continue
        deltas[(int(r.session_id), r.team_id, frozenset((r.driver_a, r.driver_b)))] = (
            r.driver_a, float(r.delta_s), float(r.delta_pct))

    groups: dict[tuple, list] = {}
    for (sid, team_id), grp in d.quali_results.groupby(["session_id", "team_id"]):
        kind = str(grp["kind"].iloc[0])
        pos = {row.driver_id: int(row.position) for row in grp.itertuples()}
        drivers = sorted(pos)
        for i, a in enumerate(drivers):
            for b in drivers[i + 1:]:
                if pos[a] == pos[b]:
                    continue  # cannot happen: positions are unique within a session
                groups.setdefault((kind, team_id, a, b), []).append((int(sid), pos[a], pos[b]))

    rows = []
    for (kind, team_id, a, b), sess in sorted(groups.items()):
        a_wins = sum(1 for _, pa, pb in sess if pa < pb)
        signed_s, signed_pct = [], []
        for sid, _, _ in sess:
            hit = deltas.get((sid, team_id, frozenset((a, b))))
            if hit is None:
                continue
            quicker, ds, dp = hit
            sign = -1.0 if quicker == a else 1.0  # negative = driver_a faster (§3.6)
            signed_s.append(sign * ds)
            signed_pct.append(sign * dp)
        pct = pd.Series(signed_pct, dtype=float)
        med_pct = float(pct.median()) if len(pct) else None
        rows.append({
            "year": d.year, "kind": kind, "team_id": team_id, "driver_a": a, "driver_b": b,
            "sessions_counted": len(sess), "a_wins": a_wins, "b_wins": len(sess) - a_wins,
            "deltas_counted": len(signed_pct),
            "median_delta_s": float(pd.Series(signed_s, dtype=float).median()) if signed_s else None,
            "median_delta_pct": med_pct,
            "mad_delta_pct": float((pct - med_pct).abs().median()) if len(pct) else None,
            "sessions_caveated": sum(1 for sid, _, _ in sess if sid in d.quali_caveated),
        })
    return pd.DataFrame(rows, columns=cols)


def _write(cur, table: str, df: pd.DataFrame) -> int:
    if df is None or len(df) == 0:
        return 0
    cast = frames.cast_frame(df, table)
    cols = list(cast.columns)
    stmt = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
        sql.Identifier(table), sql.SQL(", ").join(sql.Identifier(c) for c in cols),
        sql.SQL(", ").join(sql.Placeholder() for _ in cols))
    cur.executemany(stmt, list(frames.iter_rows(cast)))
    return len(cast)


def compute(conn, year: int) -> dict[str, pd.DataFrame]:
    """The aggregate frames for a year (read-only; useful for --dry-run and tests)."""
    d = _SeasonData(conn, year)
    ds, cs = [], []
    if d.standings_after_round is not None:
        for rnd in range(1, d.standings_after_round + 1):
            ds.append(_driver_standings(d, rnd))
            cs.append(_constructor_standings(d, rnd))
    driver_standings = pd.concat(ds, ignore_index=True) if ds else pd.DataFrame(columns=frames.EXPECTED_COLUMNS["driver_standings"])
    constructor_standings = pd.concat(cs, ignore_index=True) if cs else pd.DataFrame(columns=frames.EXPECTED_COLUMNS["constructor_standings"])
    return {
        "driver_standings": driver_standings,
        "constructor_standings": constructor_standings,
        "driver_season_summary": _driver_season_summary(d, driver_standings),
        "teammate_h2h": _teammate_h2h(d),
        "season_quali_h2h": _season_quali_h2h(d),
        "_meta": pd.DataFrame([{
            "ingested_rounds": int(len(d.race_ok)),
            "standings_after_round": d.standings_after_round,
            "assumption_set_id": d.assumption_set_id,
            "mixed_assumption_sets": d.mixed,
            "has_sprint_results": d.has_sprint_results,
        }]),
    }


def recompute(conn, year: int) -> None:
    """Delete and rewrite the year's aggregate rows and refresh ``seasons`` in one transaction.

    The reads and the writes share one ``conn.transaction()`` block, so when the connection is
    idle on entry (as ``ingest.run_season`` guarantees) the block is a real BEGIN ... COMMIT;
    inside a caller's own transaction it is a savepoint and the caller commits.
    """
    with conn.transaction():
        out = compute(conn, year)
        meta = out["_meta"].iloc[0]
        with conn.cursor() as cur:
            for table in ("season_quali_h2h", "teammate_h2h", "driver_season_summary", "constructor_standings", "driver_standings"):
                cur.execute(sql.SQL("DELETE FROM {} WHERE year = %s").format(sql.Identifier(table)), (year,))
            for table in ("driver_standings", "constructor_standings", "driver_season_summary", "teammate_h2h", "season_quali_h2h"):
                _write(cur, table, out[table])
            cur.execute(
                "UPDATE seasons SET ingested_rounds = %s, standings_after_round = %s, assumption_set_id = %s, "
                "mixed_assumption_sets = %s, has_sprint_results = %s, recomputed_at = %s WHERE year = %s",
                (int(meta["ingested_rounds"]),
                 None if pd.isna(meta["standings_after_round"]) else int(meta["standings_after_round"]),
                 None if pd.isna(meta["assumption_set_id"]) else int(meta["assumption_set_id"]),
                 bool(meta["mixed_assumption_sets"]), bool(meta["has_sprint_results"]),
                 dt.datetime.now(dt.timezone.utc), year),
            )
        # MODE1_SPEC §5.6: title odds and magic numbers are per-season and are rebuilt
        # inside this same transaction, so the season page's odds can never disagree with
        # the standings they were computed from.
        asid = (assumptions.get_or_create(conn) if pd.isna(meta["assumption_set_id"])
                else int(meta["assumption_set_id"]))
        title.recompute_title(conn, year, asid)
