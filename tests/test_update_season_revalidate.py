"""The cache purge after the nightly push, without a network (REVALIDATE_SPEC §3).

`scripts.update_season._revalidate_step` is driven through a real `urllib` opener whose
https handler is scripted, so the redirect refusal, the single retry, the smoke GET and the
bearer header are all exercised as they run at night. Nothing here touches a database, the
network, `~/.config` or `output/`.
"""

from __future__ import annotations

import email.message
import io
import json
import logging
import urllib.error
import urllib.request
import urllib.response
from pathlib import Path

import pytest

from scripts import push_remote as pr
from scripts import update_season as us
from scripts.push_remote import Refusal

URL = "https://f1.example.test/api/revalidate"
ORIGIN = "https://f1.example.test/"
SECRET = "s3cr3t-" + "a1b2c3d4" * 4
HOST = "f1.example.test"


class Scripted(urllib.request.BaseHandler):
    """Answers each https request from a script and records what it was asked."""

    handler_order = 100                         # ahead of the real HTTPSHandler

    def __init__(self, *steps) -> None:
        self.steps, self.seen = list(steps), []

    def https_open(self, req):
        self.seen.append((req.get_method(), req.full_url, req.get_header("Authorization"),
                          req.data))
        step = self.steps.pop(0)
        if isinstance(step, Exception):
            raise step
        code, msg = step
        headers = email.message.Message()
        if 300 <= code < 400:
            headers["Location"] = "https://elsewhere.example.test/"
        r = urllib.response.addinfourl(io.BytesIO(b"{}"), headers, req.full_url, code)
        r.msg = r.reason = msg
        return r


@pytest.fixture
def armed(tmp_path: Path, monkeypatch) -> Path:
    """A 0600 remote.env with both keys, a last_push.json, and no clock-driven waits."""
    env = tmp_path / "remote.env"
    env.write_text(f"REVALIDATE_URL={URL}\nREVALIDATE_SECRET='{SECRET}'\n")
    env.chmod(0o600)
    last_push = tmp_path / "last_push.json"
    last_push.write_text(json.dumps({"release_id": 7, "ok": True}))
    monkeypatch.setattr(us, "REMOTE_ENV", env)
    monkeypatch.setattr(us, "LAST_REVALIDATE", tmp_path / "last_revalidate.json")
    monkeypatch.setattr(pr, "LAST_PUSH", last_push)
    monkeypatch.delenv("REVALIDATE_URL", raising=False)
    monkeypatch.delenv("REVALIDATE_SECRET", raising=False)
    monkeypatch.setattr(us.time, "sleep", lambda s: None)
    return tmp_path


def _wire(monkeypatch, *steps) -> Scripted:
    h = Scripted(*steps)
    monkeypatch.setattr(us, "_opener", lambda: urllib.request.build_opener(us._NoRedirect, h))
    return h


def _run(caplog, dry_run: bool = False) -> list[str]:
    caplog.set_level(logging.INFO, logger="update_season")
    failures: list[str] = []
    us._revalidate_step(failures, [17], dry_run=dry_run)
    assert SECRET not in caplog.text
    return failures


def _last(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "last_revalidate.json").read_text())


def test_200_then_smoke_200_is_ok(armed, monkeypatch, caplog):
    h = _wire(monkeypatch, (200, "OK"), (200, "OK"))
    assert _run(caplog) == []
    assert f"revalidate: OK {HOST} release_id=7 in " in caplog.text
    assert h.seen == [("POST", URL, "Bearer " + SECRET, b'{"release_id": 7}'),
                      ("GET", ORIGIN, None, None)]
    last = _last(armed)
    assert (last["status"], last["reason"], last["host"]) == ("ok", "release_id=7", HOST)
    assert last["at"].endswith("+00:00")


def test_401_is_a_failure_without_retry_or_smoke(armed, monkeypatch, caplog):
    h = _wire(monkeypatch, (401, "Unauthorized"))
    assert _run(caplog) == ["revalidate: 401 Unauthorized"]
    assert f"revalidate: FAILED {HOST} 401 Unauthorized" in caplog.text
    assert len(h.seen) == 1
    assert _last(armed)["status"] == "failed" and _last(armed)["reason"] == "401 Unauthorized"


def test_urlerror_then_200_is_one_retry_then_ok(armed, monkeypatch, caplog):
    h = _wire(monkeypatch, urllib.error.URLError("cold start"), (200, "OK"), (200, "OK"))
    assert _run(caplog) == []
    assert "revalidate: URLError; retrying in 5s" in caplog.text
    assert f"revalidate: OK {HOST} release_id=7" in caplog.text
    assert [m for m, *_ in h.seen] == ["POST", "POST", "GET"]


def test_5xx_twice_is_a_failure_after_one_retry(armed, monkeypatch, caplog):
    h = _wire(monkeypatch, (503, "Service Unavailable"), (503, "Service Unavailable"))
    assert _run(caplog) == ["revalidate: 503 Service Unavailable"]
    assert len(h.seen) == 2 and _last(armed)["status"] == "failed"


def test_301_is_refused_not_followed(armed, monkeypatch, caplog):
    # A followed redirect would re-send the bearer header as a GET somewhere else.
    h = _wire(monkeypatch, (301, "Moved Permanently"))
    assert _run(caplog) == ["revalidate: 301 Moved Permanently"]
    assert f"revalidate: FAILED {HOST} 301 Moved Permanently" in caplog.text
    assert [u for _, u, *_ in h.seen] == [URL]
    assert us._NoRedirect().redirect_request(None, None, 301, "", {}, "https://x/") is None


def test_failed_smoke_get_is_a_failure(armed, monkeypatch, caplog):
    _wire(monkeypatch, (200, "OK"), (500, "Internal Server Error"))
    assert _run(caplog) == ["revalidate: smoke GET 500 Internal Server Error"]


def test_previous_failure_is_named_before_the_next_attempt(armed, monkeypatch, caplog):
    (armed / "last_revalidate.json").write_text(json.dumps(
        {"at": "2026-09-21T04:07:10+00:00", "status": "failed",
         "reason": "503 Service Unavailable", "host": HOST}))
    _wire(monkeypatch, (200, "OK"), (200, "OK"))
    assert _run(caplog) == []
    assert ("revalidate: previous run FAILED (2026-09-21T04:07:10+00:00: 503 Service "
            "Unavailable)") in caplog.text
    assert _last(armed)["status"] == "ok"


def test_no_keys_is_a_skip_not_a_failure(armed, monkeypatch, caplog):
    (armed / "remote.env").write_text("REMOTE_DATABASE_URL=postgres://x\n")
    h = _wire(monkeypatch)                      # any request would pop an empty script
    assert _run(caplog) == []
    assert "revalidate: no REVALIDATE_URL -- skipped (local only)" in caplog.text
    assert h.seen == [] and _last(armed)["status"] == "skipped"


def test_dry_run_says_what_it_would_do_and_writes_nothing(armed, monkeypatch, caplog):
    h = _wire(monkeypatch)
    assert _run(caplog, dry_run=True) == []
    assert f"revalidate: would POST {HOST}" in caplog.text
    assert h.seen == [] and not (armed / "last_revalidate.json").exists()


def test_read_remote_env_refuses_a_loose_file_and_prefers_the_environment(tmp_path: Path):
    f = tmp_path / "remote.env"
    f.write_text(f"REVALIDATE_URL='{URL}'\nREVALIDATE_SECRET=\"{SECRET}\"\nOTHER=1\n")
    f.chmod(0o644)
    with pytest.raises(Refusal, match="0644; it must be 0600"):
        pr.read_remote_env(us.REVALIDATE_KEYS, f, env={})
    f.chmod(0o600)
    assert pr.read_remote_env(us.REVALIDATE_KEYS, f, env={}) == \
        {"REVALIDATE_URL": URL, "REVALIDATE_SECRET": SECRET}
    assert pr.read_remote_env(us.REVALIDATE_KEYS, f, env={"REVALIDATE_URL": "https://e/"}) == \
        {"REVALIDATE_URL": "https://e/", "REVALIDATE_SECRET": SECRET}
    assert pr.read_remote_env(["MISSING"], f, env={}) == {}
    assert pr.read_remote_env(us.REVALIDATE_KEYS, tmp_path / "absent.env", env={}) == {}
