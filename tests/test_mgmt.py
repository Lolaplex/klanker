"""Live hub-link + session host switch management (agents-relay#43)."""
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
    (h.clients).mkdir(parents=True, exist_ok=True)
    return h


def _write_hubs(host, rows):
    p = host.clients / "hubs.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"hubs": rows}))


def test_hub_links_lists_public_metadata(host, monkeypatch):
    _write_hubs(host, {"h1": {"hub_url": "https://hub:8787",
                              "device_id": "dev-me", "label": "vps",
                              "connected_at": 5, "last_seq": 0}})
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    out = mgmt.hub_links()
    assert out["links"][0]["hub_id"] == "h1"
    assert out["links"][0]["device_id"] == "dev-me"
    assert out["links"][0]["connected"] is False
    assert "token" not in json.dumps(out)


def test_parse_connect_pair_url_and_bare():
    url, code = mgmt._parse_connect(
        {"url": "https://hub.example:8787/#pair=ABCD-EF_12"})
    assert url == "https://hub.example:8787"
    assert code == "ABCD-EF_12"
    url, code = mgmt._parse_connect(
        {"url": "http://h:1", "code": "zz99"})
    assert (url, code) == ("http://h:1", "zz99")
    # no url / bad code -> rejected
    assert mgmt._parse_connect({"url": "ftp://x", "code": "ab1"}) == ("", "")
    assert mgmt._parse_connect({"url": "http://h"}) == ("http://h", "")


def test_hub_connect_redeems_persists_and_attaches(host, monkeypatch):
    monkeypatch.setattr(mgmt, "_hubs_path",
                        lambda: host.clients / "hubs.json")
    attached = []

    class _FakeRt:
        def _attach_new_hubs(self):
            attached.append(1)

        def client_connected(self, hid):
            return True

    monkeypatch.setattr(mgmt, "_runtime", lambda: _FakeRt())

    import agents_relay.channel_client as cc

    def fake_connect(url, cred, *, label=""):
        assert url == "https://hub:8787"
        assert cred == "ABCD"
        return {"hub_id": "hub1", "device_id": "dev-me",
                "ws": "w9", "reused": True,
                "hub_url": url, "label": label}

    monkeypatch.setattr(cc, "connect_hub", fake_connect)
    out = mgmt.hub_connect(
        {"url": "https://hub:8787/#pair=ABCD", "label": "vps"})
    assert out["ok"] is True
    assert out["hub_id"] == "hub1"
    assert out["ws"] == "w9"
    assert out["reused"] is True
    assert out["connected"] is True
    assert attached == [1]


def test_hub_connect_bad_body_400(host, monkeypatch):
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    out = mgmt.hub_connect({"url": "https://h"})
    assert out["ok"] is False
    assert out["status"] == 400


def test_hub_disconnect_stops_client_and_drops_row(host, monkeypatch):
    _write_hubs(host, {"h1": {"hub_url": "http://h",
                              "device_id": "dev-me"}})
    stopped = []

    class _FakeRt:
        def detach_client(self, hid):
            stopped.append(hid)
            return True

    monkeypatch.setattr(mgmt, "_runtime", lambda: _FakeRt())

    import agents_relay.channel_client as cc
    gone = []
    monkeypatch.setattr(cc, "disconnect_hub",
                        lambda hid: gone.append(hid) or True)
    out = mgmt.hub_disconnect("h1")
    assert out["ok"] is True
    assert stopped == ["h1"]
    assert gone == ["h1"]


def test_detach_client_retires_workers(host, monkeypatch):
    rt = wssync.SyncRuntime()

    class _Client:
        hub_id = "h1"
        device_id = "dev-me"
        stopped = False

        def stop(self):
            self.stopped = True

    class _W:
        ws_id = "w1"
        closed = False

        def close(self):
            self.closed = True

    c = _Client()
    w = _W()
    rt._clients["h1"] = c
    rt._client_workers["h1"] = [w]
    assert rt.detach_client("h1") is True
    assert c.stopped is True
    assert w.closed is True
    assert "h1" not in rt._clients
    assert rt.detach_client("h1") is False


def test_session_host_switch_rebinds(host, tmp_path, monkeypatch):
    from klanker.session import bind_session, session_view

    ws = host.create("w1")
    conn = connect(ws.dir / "store.db", check_same_thread=False)
    bind_session(conn, "s1", "dev-a")
    conn.close()
    monkeypatch.setattr(
        "klanker.session._lease_holder_for", lambda w, s: "")
    out = mgmt.session_host_switch("w1", "s1", "dev-b")
    assert out.get("host") == "dev-b"
    conn = connect(ws.dir / "store.db")
    try:
        assert session_view(conn, "s1")["host"] == "dev-b"
    finally:
        conn.close()


def test_session_host_switch_conflict_passthrough(host, monkeypatch):
    from klanker.session import bind_session

    ws = host.create("w1")
    conn = connect(ws.dir / "store.db", check_same_thread=False)
    bind_session(conn, "s1", "dev-a")
    conn.close()
    monkeypatch.setattr(
        "klanker.session._lease_holder_for", lambda w, s: "dev-c")
    monkeypatch.setattr(
        "klanker.session._own_holder_id", lambda: "dev-a")
    out = mgmt.session_host_switch("w1", "s1", "dev-b")
    assert out["error"] == "lease_held"
    assert out["status"] == 409


def test_session_host_switch_unknown_ws_404(host):
    out = mgmt.session_host_switch("nope", "s1", "dev-b")
    assert out["status"] == 404


def test_ws_policy_changed_runs_reconcile(host, monkeypatch):
    calls = []

    class _FakeRt:
        def _reconcile_shares(self):
            calls.append(1)

    monkeypatch.setattr(mgmt, "_runtime", lambda: _FakeRt())
    mgmt.ws_policy_changed("w1")
    assert calls == [1]
    # no runtime -> silent no-op (never blocks a PATCH)
    monkeypatch.setattr(mgmt, "_runtime", lambda: None)
    mgmt.ws_policy_changed("w1")
    assert calls == [1]
