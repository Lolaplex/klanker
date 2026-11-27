from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from agents_workspace import Host
from klanker import mgmt
from klanker.sensing import probe_host


class _Handler:
    def __init__(self, path: str, ctx: dict | None = None, body: dict | None = None):
        self.path = path
        self.relay_secret = "sec"
        self._ctx_val = ctx if ctx is not None else {"kind": "admin"}
        self._body = body
        self.error: tuple[int, str] | None = None
        self.json_body: dict | None = None
        self.status: int | None = None

    def _auth_ctx(self) -> dict:
        return self._ctx_val

    def send_error(self, code: int, msg: str = "") -> None:
        self.error = (code, msg)

    def _write_json(self, payload: dict, status: int = 200) -> None:
        self.json_body = payload
        self.status = status

    def _read_json(self):
        return self._body


@pytest.fixture
def authed_ws(tmp_path: Path, monkeypatch):
    host_dir = tmp_path / "host"
    monkeypatch.setenv("AGENTS_HOST_DIR", str(host_dir))
    monkeypatch.setenv("AGENTS_WORKSPACE", "default")
    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    ws = host.create("default")
    wd = Path(ws.workdir)
    wd.mkdir(parents=True, exist_ok=True)
    with patch("agents_relay.http_adapter._check_secret", return_value=True):
        yield host, ws, wd


def _init_git_repo(repo: Path) -> None:
    subprocess.run(["git", "-C", str(repo), "init"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.com"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Test User"], check=True, capture_output=True)
    (repo / "app.py").write_text("print('v1')\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "app.py"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-m", "init"], check=True, capture_output=True)


def test_device_tokens_denied_on_all_new_u14_routes(authed_ws):
    routes = [
        ("GET", "/v1/klanker/doctor", None),
        ("GET", "/v1/klanker/stats", None),
        ("GET", "/v1/klanker/files", None),
        ("GET", "/v1/klanker/files/read?path=a.py", None),
        ("GET", "/v1/klanker/files/grep?q=foo", None),
        ("GET", "/v1/klanker/bg", None),
        ("GET", "/v1/klanker/bg/bg_12345678/logs", None),
        ("GET", "/v1/klanker/sessions/ses_1/git", None),
        ("GET", "/v1/klanker/git", None),
        ("GET", "/v1/klanker/skills/demo", None),
        ("POST", "/v1/klanker/sessions/fork", {"source_session": "ses_1"}),
        ("POST", "/v1/klanker/bg/bg_12345678/kill", {}),
        ("PUT", "/v1/klanker/memory/file", {"path": "note.md", "content": "hi"}),
        ("PUT", "/v1/klanker/skills/demo", {"content": "# Demo\n"}),
    ]
    for role in ("client", "ws_member"):
        ctx = {"kind": "device", "role": role, "device_id": "dev_1", "allowlist": frozenset(["default"])}
        for method, path, body in routes:
            h = _Handler(path, ctx=ctx, body=body)
            handled = mgmt._dispatch(h, method)
            assert handled is True
            assert h.error is not None and h.error[0] == 403, f"{role} {method} {path} -> {h.error}"


def test_fork_route_and_invalid_inputs(authed_ws):
    _, ws, _ = authed_ws
    from agents_traces.models import TraceEvent
    from agents_traces.store import TraceStore

    TraceStore(ws.traces).append(TraceEvent(session="ses_src1", type="message", metadata={"role": "user", "content": "hi"}))

    h = _Handler("/v1/klanker/sessions/fork", body={"workspace": "default", "source_session": "ses_src1"})
    mgmt._dispatch(h, "POST")
    assert h.status == 200
    assert h.json_body is not None and h.json_body["session"].startswith("ses_fork_")
    forked = TraceStore(ws.traces).get_events_for_session(h.json_body["session"])
    assert len(forked) == 1

    TraceStore(ws.traces).append(TraceEvent(session="ses_src1", type="message", metadata={"role": "assistant", "content": "answer"}))
    h_part = _Handler("/v1/klanker/sessions/fork", body={"workspace": "default", "source_session": "ses_src1", "through_message": 1})
    mgmt._dispatch(h_part, "POST")
    assert h_part.status == 200
    partial = TraceStore(ws.traces).get_events_for_session(h_part.json_body["session"])
    assert len(partial) == 1
    assert partial[0].metadata["content"] == "hi"

    h_missing = _Handler("/v1/klanker/sessions/fork", body={"workspace": "default", "source_session": "ses_none"})
    mgmt._dispatch(h_missing, "POST")
    assert h_missing.error is not None and h_missing.error[0] == 404


def test_files_read_grep_and_traversal_refusal(authed_ws, tmp_path: Path):
    _, _, wd = authed_ws
    (wd / "hello.txt").write_text("line1\nneedle here\nline3\n", encoding="utf-8")
    outside = tmp_path / "secret.txt"
    outside.write_text("top-secret", encoding="utf-8")

    h_ls = _Handler("/v1/klanker/files?workspace=default&path=.")
    mgmt._dispatch(h_ls, "GET")
    assert h_ls.status == 200
    assert any(e["name"] == "hello.txt" for e in h_ls.json_body["entries"])

    h_rd = _Handler("/v1/klanker/files/read?workspace=default&path=hello.txt&offset=2&limit=1")
    mgmt._dispatch(h_rd, "GET")
    assert h_rd.status == 200
    assert "needle here" in h_rd.json_body["content"]

    h_gr = _Handler("/v1/klanker/files/grep?workspace=default&q=needle")
    mgmt._dispatch(h_gr, "GET")
    assert h_gr.status == 200
    assert len(h_gr.json_body["matches"]) == 1

    for bad_path in (
        "/v1/klanker/files?workspace=default&path=..",
        "/v1/klanker/files/read?workspace=default&path=../secret.txt",
        "/v1/klanker/files/grep?workspace=default&q=secret&path=..",
    ):
        h_bad = _Handler(bad_path)
        mgmt._dispatch(h_bad, "GET")
        assert h_bad.error is not None and h_bad.error[0] in (400, 403)


def test_session_git_diff_and_cap(authed_ws):
    _, _, wd = authed_ws
    _init_git_repo(wd)
    (wd / "app.py").write_text("print('v2')\n", encoding="utf-8")

    h = _Handler("/v1/klanker/sessions/ses_git1/git?workspace=default&file=app.py")
    mgmt._dispatch(h, "GET")
    assert h.status == 200
    assert h.json_body["is_git"] is True
    assert h.json_body["diff_truncated"] is False
    assert any(d["path"] == "app.py" for d in h.json_body["dirty_files"])
    assert "+print('v2')" in h.json_body["diff"]

    h_esc = _Handler("/v1/klanker/sessions/ses_git1/git?workspace=default&file=../nope.py")
    mgmt._dispatch(h_esc, "GET")
    assert h_esc.error is not None and h_esc.error[0] == 403

    # Exceed 128KB cap -> diff_truncated=True
    (wd / "big.txt").write_text("A\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(wd), "add", "big.txt"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(wd), "commit", "-m", "big"], check=True, capture_output=True)
    (wd / "big.txt").write_text("B\n" * 80_000, encoding="utf-8")
    h_big = _Handler("/v1/klanker/sessions/ses_git1/git?workspace=default&file=big.txt")
    mgmt._dispatch(h_big, "GET")
    assert h_big.status == 200
    assert h_big.json_body["diff_truncated"] is True


def test_workspace_git_without_session(authed_ws):
    _, _, wd = authed_ws

    h_none = _Handler("/v1/klanker/git?workspace=default")
    mgmt._dispatch(h_none, "GET")
    assert h_none.status == 200
    assert h_none.json_body["is_git"] is False
    assert h_none.json_body["dirty_files"] == []

    _init_git_repo(wd)
    (wd / "app.py").write_text("print('workspace')\n", encoding="utf-8")
    h = _Handler("/v1/klanker/git?workspace=default&file=app.py")
    mgmt._dispatch(h, "GET")
    assert h.status == 200
    assert h.json_body["is_git"] is True
    assert h.json_body["branch"]
    assert any(d["path"] == "app.py" for d in h.json_body["dirty_files"])
    assert "+print('workspace')" in h.json_body["diff"]
    assert h.json_body["diff_truncated"] is False

    h_esc = _Handler("/v1/klanker/git?workspace=default&file=../nope.py")
    mgmt._dispatch(h_esc, "GET")
    assert h_esc.error is not None and h_esc.error[0] == 403


def test_bg_routes_stats_and_doctor_no_secrets(authed_ws, monkeypatch):
    _, ws, _ = authed_ws
    from agents_traces.models import TraceEvent
    from agents_traces.store import TraceStore

    TraceStore(ws.traces).append(TraceEvent(session="ses_st", type="llm_call", model="m1", tokens_in=30, tokens_out=12, cost_usd=0.01))
    h_st = _Handler("/v1/klanker/stats?workspace=default&session=ses_st")
    mgmt._dispatch(h_st, "GET")
    assert h_st.status == 200
    assert h_st.json_body["stats"]["tokens_in"] == 30
    assert h_st.json_body["stats"]["tokens_out"] == 12

    monkeypatch.setenv("OPENAI_API_KEY", "sk-never-leak-this-value-999")
    h_doc = _Handler("/v1/klanker/doctor")
    mgmt._dispatch(h_doc, "GET")
    assert h_doc.status == 200
    assert "sk-never-leak-this-value-999" not in json.dumps(h_doc.json_body)

    h_bad_bg = _Handler("/v1/klanker/bg/../bad/logs")
    mgmt._dispatch(h_bad_bg, "GET")
    assert h_bad_bg.error is not None and h_bad_bg.error[0] in (400, 404)

    with (
        patch("klanker.bg.list_sessions", return_value=[{"id": "bg_deadbeef", "status": "running", "log": "/secret/path.log"}]),
        patch("klanker.bg.find", return_value={"id": "bg_deadbeef", "status": "running"}),
        patch("klanker.bg.log_tail", return_value="line1\nline2\n"),
        patch("klanker.bg.kill", return_value={"id": "bg_deadbeef", "status": "killed", "log": "/secret/path.log"}),
    ):
        h_bg = _Handler("/v1/klanker/bg")
        mgmt._dispatch(h_bg, "GET")
        assert h_bg.status == 200
        assert "log" not in h_bg.json_body["sessions"][0]

        h_logs = _Handler("/v1/klanker/bg/bg_deadbeef/logs?lines=50")
        mgmt._dispatch(h_logs, "GET")
        assert h_logs.status == 200
        assert "line2" in h_logs.json_body["logs"]

        h_kill = _Handler("/v1/klanker/bg/bg_deadbeef/kill", body={})
        mgmt._dispatch(h_kill, "POST")
        assert h_kill.status == 200
        assert h_kill.json_body["session"]["status"] == "killed"


def test_memory_put_skills_get_put_and_traversal_refusal(authed_ws):
    h_put_mem = _Handler("/v1/klanker/memory/file", body={"workspace": "default", "path": "notes/u14.md", "content": "# Notes\nok"})
    mgmt._dispatch(h_put_mem, "PUT")
    assert h_put_mem.status == 200

    h_get_mem = _Handler("/v1/klanker/memory/file?workspace=default&path=notes/u14.md")
    mgmt._dispatch(h_get_mem, "GET")
    assert h_get_mem.status == 200
    assert "ok" in h_get_mem.json_body["content"]

    h_bad_mem = _Handler("/v1/klanker/memory/file", body={"workspace": "default", "path": "../../evil.md", "content": "x"})
    mgmt._dispatch(h_bad_mem, "PUT")
    assert h_bad_mem.error is not None and h_bad_mem.error[0] == 403

    h_put_sk = _Handler("/v1/klanker/skills/my-skill", body={"workspace": "default", "content": "# My Skill\nbody"})
    mgmt._dispatch(h_put_sk, "PUT")
    assert h_put_sk.status == 200

    h_get_sk = _Handler("/v1/klanker/skills/my-skill?workspace=default")
    mgmt._dispatch(h_get_sk, "GET")
    assert h_get_sk.status == 200
    assert "# My Skill" in h_get_sk.json_body["content"]

    h_bad_sk = _Handler("/v1/klanker/skills/..", body={"workspace": "default", "content": "x"})
    mgmt._dispatch(h_bad_sk, "PUT")
    assert h_bad_sk.error is not None and h_bad_sk.error[0] in (400, 403)
