"""klanker#155 (R11) oracle coverage: ws-share ACLs, session gate dict,
migration redaction/HLC/projection, repo-paths persistence."""
import json

import pytest
from agents_store.db import connect
from agents_workspace import Host

from klanker import mgmt
from klanker import wssync


@pytest.fixture
def host(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    h = Host.from_env()
    h.dir.mkdir(parents=True, exist_ok=True)
    return h


# -- hub approval callback: member ok, stranger dropped --------------------

def test_approval_apply_accepts_member_drops_stranger(host, monkeypatch):
    """Oracle: the approval-req callback works for a ws member and
    rejects an unauthorized device (klanker#155)."""
    host.create("w1")
    ws = host.update_workspace("w1", sync_policy="shared",
                               sync_hosts=["dev-member"])
    assert ws.allows_device("dev-member")  # member gate sanity
    monkeypatch.setenv("AGENTS_RELAY_DIR", str(host.dir / "relay"))
    from agents_relay.approvals import read_approval
    from agents_relay.config import RelayConfig

    wssync.approval_apply(
        "approval-req",
        {"id": "ap-ok", "ws": "w1", "request": {"tool": "git"}},
        device_id="dev-member")
    rec = read_approval(RelayConfig.from_env(), "ap-ok")
    assert rec is not None and rec["status"] == "pending"

    wssync.approval_apply(
        "approval-req",
        {"id": "ap-evil", "ws": "w1", "request": {"tool": "git"}},
        device_id="dev-stranger")
    rec = read_approval(RelayConfig.from_env(), "ap-evil")
    assert rec is None or rec.get("status") in (None, "")


def test_approval_apply_unknown_ws_drops(host, monkeypatch):
    """A frame naming a ws this host cannot resolve fails closed."""
    monkeypatch.setenv("AGENTS_RELAY_DIR", str(host.dir / "relay"))
    wssync.approval_apply(
        "approval-req",
        {"id": "ap-nows", "ws": "no-such-ws",
         "request": {"tool": "git"}},
        device_id="dev-member")
    from agents_relay.approvals import read_approval
    from agents_relay.config import RelayConfig

    rec = read_approval(RelayConfig.from_env(), "ap-nows")
    assert rec is None or rec.get("status") in (None, "")


# -- C3: ws_member / device tokens never reach /v1/klanker/* ---------------

class _H:
    """Handler fake for mgmt._dispatch."""

    def __init__(self, path, ctx=None):
        self.path = path
        self.relay_secret = "sec"
        self.error = None
        self.json_body = None
        self._ctx = ctx or {}

    def _auth_ctx(self):
        return self._ctx

    def send_error(self, code, msg=""):
        self.error = (code, msg)

    def _write_json(self, payload, status):
        self.json_body = (status, payload)

    def _read_json(self):
        return {}


@pytest.fixture
def _authed(monkeypatch):
    import agents_relay.http_adapter as ha

    monkeypatch.setattr(ha, "_check_secret", lambda *a, **k: True)


@pytest.mark.parametrize("path", [
    "/v1/klanker/routines",
    "/v1/klanker/memory/PROJECTS.md",
    "/v1/klanker/skills",
])
def test_ws_member_denied_on_klanker_admin_graft(host, _authed, path):
    """Oracle: a ws_member token on a foreign /v1/klanker/* path -> 403."""
    host.create("w1")
    h = _H(path, ctx={"kind": "device", "role": "ws_member",
                      "device_id": "dev-guest", "allowlist": ["w1"]})
    assert mgmt._dispatch(h, "GET") is True
    assert h.error is not None and h.error[0] == 403, h.error


def test_non_member_device_denied_on_klanker_graft(host, _authed):
    """Host/client device tokens are channel credentials — 403."""
    host.create("w1")
    h = _H("/v1/klanker/routines",
           ctx={"kind": "device", "role": "client",
                "device_id": "dev-x"})
    assert mgmt._dispatch(h, "GET") is True
    assert h.error[0] == 403


def test_admin_ctx_reaches_klanker_graft(host, _authed, monkeypatch):
    """Sanity: the admin/cookie path still flows into _get."""
    host.create("w1")
    seen = []
    monkeypatch.setattr(mgmt, "_get",
                        lambda h, p, q: seen.append(p)
                        or h._write_json({"ok": True}, 200))
    h = _H("/v1/klanker/routines", ctx={"kind": "admin"})
    assert mgmt._dispatch(h, "GET") is True
    assert seen == ["/v1/klanker/routines"]
    assert h.json_body[0] == 200


# -- GET/PUT /v1/workspaces/<ws>/repo-paths ---------------------------------

class _PathsH(_H):
    def __init__(self, path, ctx=None, body=None):
        super().__init__(path, ctx)
        self._body = body or {}

    def _read_json(self):
        return self._body


def test_repo_paths_put_persists_host_paths_json(host, _authed):
    """Oracle: PUT writes host_paths.json; GET reads it back."""
    host.create("w1")
    h = _PathsH("/v1/workspaces/w1/repo-paths", ctx={"kind": "admin"},
                body={"paths": {"myrepo": "/srv/checkouts/myrepo"}})
    mgmt._repo_paths(h, "PUT", "/v1/workspaces/w1/repo-paths", {})
    assert h.json_body[0] == 200
    data = json.loads(host.host_paths.read_text())
    assert data["w1"]["myrepo"] == "/srv/checkouts/myrepo"

    h2 = _PathsH("/v1/workspaces/w1/repo-paths", ctx={"kind": "admin"})
    mgmt._repo_paths(h2, "GET", "/v1/workspaces/w1/repo-paths", {})
    assert h2.json_body[1]["paths"] == {"myrepo": "/srv/checkouts/myrepo"}


def test_repo_paths_device_non_owner_403(host, _authed):
    ws = host.create("w1")
    host.update_workspace("w1", execution={"owner": "dev-owner"})
    h = _PathsH("/v1/workspaces/w1/repo-paths",
                ctx={"kind": "device", "device_id": "dev-guest",
                     "role": "ws_member"})
    mgmt._repo_paths(h, "GET", "/v1/workspaces/w1/repo-paths", {})
    assert h.error[0] == 403
    # the recorded owner may read
    h2 = _PathsH("/v1/workspaces/w1/repo-paths",
                 ctx={"kind": "device", "device_id": "dev-owner",
                      "role": "host"})
    mgmt._repo_paths(h2, "GET", "/v1/workspaces/w1/repo-paths", {})
    assert h2.json_body[0] == 200


# -- klanker session show parses -------------------------------------------

def test_session_show_prints_binding(host, monkeypatch, capsys):
    """Oracle: `klanker session show <id>` parses and prints the view."""
    from klanker import __main__ as cli
    from klanker.session import bind_session

    ws = host.create("w1")
    monkeypatch.setenv("AGENTS_WORKSPACE", "w1")
    conn = connect(ws.dir / "store.db")
    bind_session(conn, "ses-1", "dev-a", repo="repo")
    conn.close()
    rc = cli.main(["session", "show", "ses-1"])
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["session"] == "ses-1"
    assert parsed["host"] == "dev-a"
    assert rc == 0


# -- msgsync redaction is case-insensitive ----------------------------------

def test_msgsync_path_redaction_case_insensitive(tmp_path, monkeypatch):
    """Windows path compare is case-insensitive — the redaction is too
    there; POSIX stays exact-case (klanker#155)."""
    import os

    from klanker.msgsync import _redact_local_paths

    ws = tmp_path / "Work" / "Space"
    ws.mkdir(parents=True)
    text = f"checkout at {str(ws).upper()}/repo and {ws}/other"
    out = _redact_local_paths(text, ws)
    assert str(ws) not in out
    if os.name == "nt":
        assert str(ws).upper() not in out
    else:
        assert str(ws).upper() in out  # case-sensitive fs, no redaction
