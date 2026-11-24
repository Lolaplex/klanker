"""remote turn dispatch, run leases, and approval mirroring (klanker#148)."""
import io
import json

import pytest

from klanker import remote_dispatch as rd
from klanker import wssync


class _Headers(dict):
    def get(self, k, default=None):  # case-insensitive
        for key, v in self.items():
            if key.lower() == k.lower():
                return v
        return default


class _Handler:
    """Minimal relay-handler fake: records status + body."""

    def __init__(self, headers=None):
        self.headers = _Headers(headers or {})
        self.status = None
        self.sent_headers = {}
        self.wfile = io.BytesIO()
        self.json_body = None

    def _write_json(self, payload, status):
        self.status = status
        self.json_body = payload

    def send_response(self, status):
        self.status = status

    def send_header(self, k, v):
        self.sent_headers[k] = v

    def end_headers(self):
        pass


@pytest.fixture
def local_env(monkeypatch):
    """No session binding, no hubs, this device = 'self'."""
    monkeypatch.setattr(rd, "_session_state",
                        lambda s, w: {"host": "", "branch": "",
                                      "repo": "", "wip_unpushed": False})
    monkeypatch.setattr(rd, "_own_device_ids", lambda: {"self"})
    monkeypatch.setattr(rd, "_hub_rows", lambda: {})
    return monkeypatch


def test_dispatch_unbound_session_runs_local(local_env):
    h = _Handler()
    assert rd.remote_turn_dispatch(
        h, "/v1/turn", {"session": "s1", "workspace": "w1"}) is False
    assert h.status is None


def test_dispatch_bound_to_self_runs_local(local_env, monkeypatch):
    monkeypatch.setattr(rd, "_session_state",
                        lambda s, w: {"host": "self", "branch": "",
                                      "repo": "", "wip_unpushed": False})
    h = _Handler()
    assert rd.remote_turn_dispatch(
        h, "/v1/turn", {"session": "s1", "workspace": "w1"}) is False


def test_dispatch_hop_limit_refuses_loop(local_env):
    h = _Handler({"X-Klanker-Hop": "2"})
    assert rd.remote_turn_dispatch(
        h, "/v1/turn", {"session": "s1", "workspace": "w1"}) is True
    assert h.status == 508
    assert h.json_body["error"] == "dispatch_loop"


def test_dispatch_bound_unreachable_fails_loud(local_env, monkeypatch):
    monkeypatch.setattr(rd, "_session_state",
                        lambda s, w: {"host": "dev-other", "branch": "",
                                      "repo": "", "wip_unpushed": False})
    monkeypatch.setattr(rd, "_hub_rows", lambda: {})
    h = _Handler()
    assert rd.remote_turn_dispatch(
        h, "/v1/turn", {"session": "s1", "workspace": "w1"}) is True
    assert h.status == 503
    assert h.json_body["error"] == "host_offline"
    assert h.json_body["bound_host"] == "dev-other"


def test_dispatch_bound_unreachable_wip_is_409(local_env, monkeypatch):
    monkeypatch.setattr(rd, "_session_state",
                        lambda s, w: {"host": "dev-other", "branch": "",
                                      "repo": "", "wip_unpushed": True})
    h = _Handler()
    assert rd.remote_turn_dispatch(
        h, "/v1/turn", {"session": "s1", "workspace": "w1"}) is True
    assert h.status == 409
    assert h.json_body["error"] == "wip_unpushed"


def test_dispatch_bound_routes_over_channel_hub(local_env, monkeypatch):
    monkeypatch.setattr(rd, "_session_state",
                        lambda s, w: {"host": "dev-b", "branch": "",
                                      "repo": "", "wip_unpushed": False})

    class _Hub:
        def is_connected(self, dev):
            return dev == "dev-b"

        def rpc_call(self, device_id, kind, req, timeout_sec=0):
            assert device_id == "dev-b"
            assert req["req"]["x_klanker_hop"] == 1
            yield {"status": 200, "content_type": "application/json",
                   "body": json.dumps({"ok": True, "proxied": True})}

    import agents_relay.channel as ch_mod
    monkeypatch.setattr(ch_mod, "hub", lambda: _Hub())
    h = _Handler()
    assert rd.remote_turn_dispatch(
        h, "/v1/turn", {"session": "s1", "workspace": "w1"}) is True
    assert h.status == 200
    assert json.loads(h.wfile.getvalue())["proxied"] is True
    assert h.sent_headers.get("X-Klanker-Hop") == "1"


def test_dispatch_no_session_is_local(local_env):
    h = _Handler()
    assert rd.remote_turn_dispatch(h, "/v1/turn", {}) is False


# -- leases -----------------------------------------------------------------

@pytest.fixture
def clean_held(monkeypatch):
    rd._HELD.clear()
    yield
    rd._HELD.clear()


def test_lease_guard_hub_mode_acquire_and_contend(
        clean_held, monkeypatch, tmp_path):
    """No hubs.json -> in-process LeaseBook; second acquire contends."""
    monkeypatch.setattr(rd, "_hub_rows", lambda: {})
    monkeypatch.setattr(rd, "_own_device_ids", lambda: {"dev-me"})
    monkeypatch.setattr(rd, "_ws_obj", lambda w: _FakeWs(tmp_path))
    monkeypatch.setattr(rd, "_inject_workdir",
                        lambda b, w, s: None)
    from agents_relay.leases import hub_leases

    book = hub_leases()
    for s in list(book.snapshot()):
        book.release(s["ws"], s["session"], s["holder"],
                     int(s.get("fence") or 0))
    h = _Handler()
    out = rd.turn_lease_guard(
        h, {"session": "s1", "workspace": "w1", "run": "r1"}, {})
    assert out is None
    assert ("w1", "s1") in rd._HELD
    # a FOREIGN holder (other process/device) contends on (w1, s2)
    book.acquire("w1", "s2", "dev-other", "r0",
                 ttl=rd._lease_ttl("w1"))
    out = rd.turn_lease_guard(
        h, {"session": "s2", "workspace": "w1", "run": "r2"}, {})
    assert out is not None
    assert out["error"] == "lease_held"
    assert out["status"] == 409
    # release frees it
    rd.turn_lease_release({"session": "s1", "workspace": "w1"}, {})
    assert ("w1", "s1") not in rd._HELD
    out = rd.turn_lease_guard(
        h, {"session": "s1", "workspace": "w1", "run": "r3"}, {})
    assert out is None


class _FakeWs:
    def __init__(self, root, ws_id="w1"):
        self.dir = root
        self.id = ws_id
        self.execution = {}

    def is_syncable(self):
        return False

    def allows_device(self, d):
        return False


def test_lease_guard_no_session_is_noop(clean_held):
    assert rd.turn_lease_guard(_Handler(), {}, {}) is None


def test_lease_guard_spoke_offline_falls_back_to_lockfile(
        clean_held, monkeypatch, tmp_path):
    """Spoke with dead hub -> ws-local lockfile, never a double-run."""
    monkeypatch.setattr(
        rd, "_hub_rows",
        lambda: {"h": {"hub_url": "http://127.0.0.1:1",
                       "device_id": "dev-me"}})
    monkeypatch.setattr(rd, "_own_device_ids", lambda: {"dev-me"})
    monkeypatch.setattr(rd, "_ws_obj", lambda w: _FakeWs(tmp_path))
    monkeypatch.setattr(rd, "_inject_workdir", lambda b, w, s: None)
    monkeypatch.setattr(rd, "_hub_lease_call",
                        lambda *a, **k: {})  # hub dead
    out = rd.turn_lease_guard(
        _Handler(), {"session": "s1", "workspace": "w1"}, {})
    assert out is None
    lock = tmp_path / "run" / "session-s1.lock"
    assert lock.is_file()
    # a fresh lock from a FOREIGN holder (other process) conflicts —
    # simulate the other process' lockfile on a different session
    import json as _json
    import time as _time

    other = tmp_path / "run" / "session-s2.lock"
    other.write_text(_json.dumps(
        {"holder": "dev-x", "ts": _time.time(), "ttl": 45.0}))
    out = rd.turn_lease_guard(
        _Handler(), {"session": "s2", "workspace": "w1"}, {})
    assert out["error"] == "lease_held"
    assert out["holder"] == "dev-x"
    # release removes the lockfile
    monkeypatch.setattr(rd, "_own_device_ids", lambda: {"dev-me"})
    rd.turn_lease_release({"session": "s1", "workspace": "w1"}, {})
    assert not lock.exists()


# -- switch_host --------------------------------------------------------------

def test_switch_host_lease_held_blocks(tmp_path, monkeypatch):
    from agents_store.db import connect

    from klanker.session import bind_session, switch_host

    conn = connect(tmp_path / "store.db")
    bind_session(conn, "s1", "dev-a")
    monkeypatch.setattr(
        "klanker.session._lease_holder_for",
        lambda ws, s: "dev-b")
    monkeypatch.setattr(
        "klanker.session._own_holder_id", lambda: "dev-a")
    res = switch_host(conn, "s1", "dev-c", ws_id="w1")
    assert res["bound"] is False
    assert res["error"] == "lease_held"
    assert res["holder"] == "dev-b"
    assert res["status"] == 409
    conn.close()


def test_switch_host_wip_unpushed_blocks_unless_forced(
        tmp_path, monkeypatch):
    from agents_store.db import connect

    from klanker.session import (bind_session, set_wip_unpushed,
                                 switch_host)

    conn = connect(tmp_path / "store.db")
    bind_session(conn, "s1", "dev-a")
    set_wip_unpushed(conn, "s1", True)
    monkeypatch.setattr(
        "klanker.session._lease_holder_for", lambda ws, s: "")
    res = switch_host(conn, "s1", "dev-b", ws_id="w1")
    assert res["bound"] is False
    assert res["error"] == "wip_unpushed"
    res = switch_host(conn, "s1", "dev-b", ws_id="w1", force=True)
    assert res["bound"] is True
    conn.close()


def test_switch_host_rebinds_clean_session(tmp_path, monkeypatch):
    from agents_store.db import connect

    from klanker.session import (bind_session, session_view,
                                 switch_host)

    conn = connect(tmp_path / "store.db")
    bind_session(conn, "s1", "dev-a")
    monkeypatch.setattr(
        "klanker.session._lease_holder_for", lambda ws, s: "")
    res = switch_host(conn, "s1", "dev-b", ws_id="w1")
    assert res["bound"] is True
    assert session_view(conn, "s1")["host"] == "dev-b"
    conn.close()


# -- approval mirroring -------------------------------------------------------

def test_approval_req_creates_mirror_record(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    # member ACL is covered separately (test_ws_share_acl); these tests
    # exercise the mirror mechanics with a member-shaped frame
    monkeypatch.setattr(wssync, "_ws_allows_device", lambda w, d: True)
    wssync.approval_apply(
        "approval-req",
        {"id": "ap1", "ws": "w1",
         "request": {"tool": "git", "summary": "push"}},
        device_id="dev-remote")
    from agents_relay.approvals import read_approval
    from agents_relay.config import RelayConfig

    rec = read_approval(RelayConfig.from_env(), "ap1")
    assert rec is not None
    assert rec["status"] == "pending"
    assert rec["request"]["__device"] == "dev-remote"


def test_approval_res_records_decision_and_forwards(
        tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    monkeypatch.setattr(wssync, "_ws_allows_device", lambda w, d: True)
    wssync.approval_apply(
        "approval-req",
        {"id": "ap2", "ws": "w1", "request": {"tool": "git"}},
        device_id="dev-remote")
    sent = []

    class _Hub:
        def publish(self, dev, kind, payload):
            sent.append((dev, kind, payload))

    import agents_relay.channel as ch_mod
    monkeypatch.setattr(ch_mod, "hub", lambda: _Hub())
    wssync.approval_apply(
        "approval-res",
        {"id": "ap2", "status": "approved", "note": "ok",
         "device": "dev-remote", "ws": "w1"})
    from agents_relay.approvals import read_approval
    from agents_relay.config import RelayConfig

    rec = read_approval(RelayConfig.from_env(), "ap2")
    assert rec is not None
    assert rec["status"] == "approved"
    # res forwarded to the origin device
    assert sent == [("dev-remote", "approval-res",
                     {"id": "ap2", "status": "approved", "note": "ok",
                      "device": "dev-remote", "ws": "w1"})]


def test_approval_mirror_apply_never_echoes(tmp_path, monkeypatch):
    """A mirror-applied pending must not re-fire on_pending_fn."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    monkeypatch.setattr(wssync, "_ws_allows_device", lambda w, d: True)
    fired = []
    import agents_relay.approvals as appr

    old = appr.on_pending_fn
    appr.on_pending_fn = lambda rec: fired.append(rec.get("id"))
    try:
        wssync.approval_apply(
            "approval-req",
            {"id": "ap3", "ws": "w1", "request": {"tool": "t"}},
            device_id="dev-r")
    finally:
        appr.on_pending_fn = old
    assert fired == []
