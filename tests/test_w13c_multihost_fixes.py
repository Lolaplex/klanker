"""Wave 13C live PC<->VPS multi-host regressions."""
import json

import pytest
from agents_workspace import Host

from klanker import mgmt
from klanker import remote_dispatch as rd
from klanker import wssync


@pytest.fixture
def host(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    h = Host.from_env()
    h.dir.mkdir(parents=True, exist_ok=True)
    h.clients.mkdir(parents=True, exist_ok=True)
    return h


@pytest.fixture
def clean_held():
    rd._HELD.clear()
    yield
    for key in list(rd._HELD):
        rd._release(*key)


def _write_hubs(host, rows):
    p = host.clients / "hubs.json"
    p.write_text(json.dumps({"hubs": rows}))


class _FakeWs:
    def __init__(self, root, policy="local"):
        self.dir = root
        self.id = "w1"
        self.execution = {}
        self.sync_policy = policy

    def is_syncable(self):
        return False

    def allows_device(self, _device):
        return False


def test_local_spoke_workspace_never_calls_hub_lease(clean_held, monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(rd, "_hub_rows", lambda: {"hub1": {"hub_url": "http://hub", "device_id": "dev-me"}})
    monkeypatch.setattr(rd, "_own_device_ids", lambda: {"dev-me"})
    monkeypatch.setattr(rd, "_ws_obj", lambda _w: _FakeWs(tmp_path, "local"))
    monkeypatch.setattr(rd, "_inject_workdir", lambda *_a: None)
    monkeypatch.setattr(rd, "_hub_lease_call", lambda *a, **k: calls.append((a, k)) or {"granted": False, "status": 403})
    assert rd.turn_lease_guard(object(), {"session": "s1", "workspace": "w1"}, {}) is None
    assert calls == []
    assert (tmp_path / "run" / "session-s1.lock").is_file()


def test_unprovisioned_synced_workspace_404_falls_back_local(clean_held, monkeypatch, tmp_path):
    monkeypatch.setattr(rd, "_hub_rows", lambda: {"hub1": {"hub_url": "http://hub", "device_id": "dev-me"}})
    monkeypatch.setattr(rd, "_own_device_ids", lambda: {"dev-me"})
    monkeypatch.setattr(rd, "_ws_obj", lambda _w: _FakeWs(tmp_path, "synced"))
    monkeypatch.setattr(rd, "_inject_workdir", lambda *_a: None)
    monkeypatch.setattr(rd, "_hub_lease_call", lambda *a, **k: {"granted": False, "status": 404, "error": "unknown workspace"})
    assert rd.turn_lease_guard(object(), {"session": "s1", "workspace": "w1"}, {}) is None
    assert (tmp_path / "run" / "session-s1.lock").is_file()


def test_spoke_hosts_hub_and_peers_despite_workspace_404(host, monkeypatch):
    _write_hubs(host, {"hub1": {"hub_url": "http://hub", "device_id": "dev-me", "label": "klanker-vps"}})
    ws = host.create("w1")
    host.update_workspace("w1", sync_policy="synced", execution={"owner": "dev-me", "failover": "none"})

    class _Rt:
        def client_connected(self, _hid):
            return True

    monkeypatch.setattr(mgmt, "_runtime", lambda: _Rt())
    import agents_relay.channel_client as cc
    monkeypatch.setattr(cc, "hub_token", lambda _hid: "tok")

    def fake_http(url, **_kw):
        if url.endswith("/v1/hub/peers"):
            return 200, {"peers": [
                {"device_id": "dev-me", "host_id": host.host_id(), "label": "FelixPC", "role": "host", "online": True},
                {"device_id": "dev-other", "label": "OtherPC", "role": "host", "online": True},
                {"device_id": "guest", "label": "Guest", "role": "ws_member", "online": True},
            ]}
        if "/v1/workspaces/w1/hosts" in url:
            return 404, {"error": "unknown workspace"}
        return 500, {}

    monkeypatch.setattr(mgmt, "_http_json", fake_http)
    out = mgmt.spoke_hosts("w1")
    assert out is not None
    assert out["hub_offline"] is False
    ids = [r["device_id"] for r in out["hosts"]]
    assert "hub1" in ids
    assert ids.count("dev-me") == 1
    assert "dev-other" in ids
    assert "guest" not in ids
    mine = out["hosts"][ids.index("dev-me")]
    assert mine["self"] is True
    assert mine["via"] == "local"
    assert out["self_device_id"] == "dev-me"
    ws.dir  # silence fixture lint noise


def test_spoke_hosts_synthesizes_older_hub(host, monkeypatch):
    _write_hubs(host, {"hub1": {"hub_url": "http://hub", "device_id": "dev-me", "label": "klanker-vps"}})
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    import agents_relay.channel_client as cc
    monkeypatch.setattr(cc, "hub_token", lambda _hid: "tok")

    def fake_http(url, **_kw):
        if url.endswith("/v1/hub/peers"):
            return 404, {}
        if url.endswith("/health"):
            return 200, {}
        return 500, {}

    monkeypatch.setattr(mgmt, "_http_json", fake_http)
    out = mgmt.spoke_hosts("missing-ws")
    assert out["hub_offline"] is False
    assert any(r["device_id"] == "hub1" and r["role"] == "hub" for r in out["hosts"])


def test_ws_invite_auth_admin_accepts_local_or_hub_device_owner(host):
    host.create("w1")
    host.update_workspace("w1", execution={"owner": host.host_id(), "failover": "none"})
    assert wssync.ws_invite_auth("__admin__", "w1")
    host.update_workspace("w1", execution={"owner": "dev-me", "failover": "none"})
    _write_hubs(host, {"hub1": {"hub_url": "http://hub", "device_id": "dev-me"}})
    assert wssync.ws_invite_auth("__admin__", "w1")
    host.update_workspace("w1", execution={"owner": "other", "failover": "none"})
    assert not wssync.ws_invite_auth("__admin__", "w1")


def test_ws_invite_proxy_announces_then_mints_through_hub(host, monkeypatch):
    ws = host.create("w1")
    _write_hubs(host, {"hub1": {"hub_url": "http://hub", "device_id": "dev-me"}})
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    import agents_relay.channel_client as cc
    monkeypatch.setattr(cc, "hub_token", lambda _hid: "tok")
    announced = []
    import klanker.wshare as wshare
    monkeypatch.setattr(wshare, "_post_ws_announce", lambda row, dev, token, payload: announced.append(payload))

    def fake_http(url, **kw):
        assert url == "http://hub/v1/ws/invite"
        assert kw["method"] == "POST"
        assert kw["token"] == "tok"
        assert kw["device_id"] == "dev-me"
        return 200, {"ok": True, "pair_url": "https://klanker.lolax.dev/#kind=ws&ws=w1&pair=CODE"}

    monkeypatch.setattr(mgmt, "_http_json", fake_http)
    out = mgmt.ws_invite_proxy("w1", ttl_sec=60)
    assert out["ok"] is True
    assert announced and announced[0]["owner"] == "dev-me"
    after = host.workspace("w1")
    assert after.sync_policy == "synced"
    assert after.execution["owner"] == "dev-me"
    assert "dev-me" in after.sync_hosts
    ws.dir


def test_ws_policy_changed_stamps_spoke_device_owner(host, monkeypatch):
    host.create("w1")
    host.update_workspace("w1", sync_policy="synced")
    _write_hubs(host, {"hub1": {"hub_url": "http://hub", "device_id": "dev-me"}})
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    mgmt.ws_policy_changed("w1")
    ws = host.workspace("w1")
    assert ws.execution["owner"] == "dev-me"
    assert "dev-me" in ws.sync_hosts


def test_hub_connect_passes_spoke_and_hub_labels(host, monkeypatch):
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    import agents_relay.channel_client as cc
    seen = {}

    def fake_connect(url, cred, *, label="", hub_label=""):
        seen.update(url=url, cred=cred, label=label, hub_label=hub_label)
        return {"hub_id": "hub1", "device_id": "dev-me", "hub_url": url}

    monkeypatch.setattr(cc, "connect_hub", fake_connect)
    out = mgmt.hub_connect({
        "url": "https://hub/#pair=ABCD-1234", "label": "FelixPC",
        "hub_label": "klanker-vps"})
    assert out["ok"] is True
    assert seen == {"url": "https://hub", "cred": "ABCD-1234",
                    "label": "FelixPC", "hub_label": "klanker-vps"}


class _InviteHandler:
    def __init__(self, ctx):
        self._ctx = ctx
        self.status = None
        self.payload = None

    def _auth_ctx(self):
        return self._ctx

    def _read_json(self):
        return {"ws": "w1", "ttl_sec": 60}

    def _write_json(self, payload, status):
        self.payload = payload
        self.status = status

    def send_error(self, status, _msg=""):
        self.status = status


def test_spoke_invite_route_intercepts_admin_and_denies_foreign_device(host, monkeypatch):
    _write_hubs(host, {"hub1": {"hub_url": "http://hub", "device_id": "dev-me"}})
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    monkeypatch.setattr(mgmt, "ws_invite_proxy",
                        lambda ws, ttl_sec=60: {"ok": True, "ws": ws, "ttl": ttl_sec})
    h = _InviteHandler({"kind": "cookie"})
    assert mgmt._ws_invite_proxy_route(h) is True
    assert h.status == 200
    assert h.payload["ws"] == "w1"
    foreign = _InviteHandler({"kind": "device", "device_id": "dev-other"})
    assert mgmt._ws_invite_proxy_route(foreign) is True
    assert foreign.status == 403
