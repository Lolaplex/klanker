"""klanker workspace share/unshare/members + share reconcile tick."""
import inspect
import json
from argparse import Namespace

import pytest


def _ws_policy_supported() -> bool:
    from agents_workspace import Host

    return "sync_policy" in inspect.signature(
        Host.update_workspace).parameters


pytestmark = pytest.mark.skipif(
    not _ws_policy_supported(),
    reason="agents-workspace without sync_policy fields")


@pytest.fixture
def host(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host

    h = Host.from_env()
    h.dir.mkdir(parents=True, exist_ok=True)
    return h


def _pair(host_dir, device_id="dev-self", hub_id="hub1"):
    """Persist a hubs.json row so the CLI knows its own device id."""
    clients = host_dir / "clients"
    clients.mkdir(parents=True, exist_ok=True)
    (clients / "hubs.json").write_text(json.dumps(
        {"hubs": {hub_id: {"device_id": device_id,
                           "hub_url": "http://hub"}}}))


def test_share_unshare_members(host, capsys):
    from klanker import wshare

    host.create("w1", label="shared")
    _pair(host.dir)
    args = Namespace(id="w1", to="dev-b", open=False)
    assert wshare.cmd_ws_share(args) == 0
    ws = host.workspace("w1")
    assert set(ws.sync_hosts) == {"dev-self", "dev-b"}
    assert (ws.execution or {}).get("owner") == "dev-self"
    assert ws.sync_policy == "synced"

    assert wshare.cmd_ws_members(Namespace(id="w1")) == 0
    out = capsys.readouterr().out
    assert "dev-b" in out and "owner" in out

    assert wshare.cmd_ws_unshare(Namespace(id="w1", to="dev-b",
                                         open=False)) == 0
    assert set(host.workspace("w1").sync_hosts) == {"dev-self"}


def test_share_refuses_self_and_unknown(host):
    from klanker import wshare

    host.create("w1")
    _pair(host.dir)
    assert wshare.cmd_ws_share(
        Namespace(id="w1", to="dev-self")) == 2          # own id
    assert wshare.cmd_ws_share(
        Namespace(id="nope", to="dev-b")) == 2           # unknown ws
    assert wshare.cmd_ws_unshare(
        Namespace(id="w1", to="dev-self", open=False)) == 2


def test_unshare_open_reopens(host):
    from klanker import wshare

    host.create("w1")
    _pair(host.dir)
    wshare.cmd_ws_share(Namespace(id="w1", to="dev-b", open=False))
    wshare.cmd_ws_unshare(Namespace(id="w1", to="", open=True))
    assert list(host.workspace("w1").sync_hosts or ()) == []


def test_reconcile_announces_member_change(host):
    """`klanker ws share` edits workspace.json; the serve tick diffs the
    member set and emits ws:announce on the live channel."""
    from agents_store.db import connect  # noqa: F401  (dep sanity)
    from klanker.wssync import SyncRuntime

    ws = host.create("w1", label="shared")
    _pair(host.dir)

    class FakeClient:
        hub_id = "hub1"
        device_id = "dev-self"
        def __init__(self):
            self.sent = []
            self.on_ws = self.on_op = self.on_ack = self.on_hello = None
        def send(self, kind, payload):
            self.sent.append((kind, payload))

    client = FakeClient()
    rt = SyncRuntime()
    rt.attach_client(client, [( "w1", ws.dir)])
    rt.tick()
    assert not [k for k, _ in client.sent if k == "ws:announce"]  # open ws silent

    host.update_workspace("w1", sync_hosts=["dev-self", "dev-b"])
    rt.tick()
    ann = [p for k, p in client.sent if k == "ws:announce"]
    assert ann and ann[0]["sync_hosts"] == ["dev-b", "dev-self"]
    assert ann[0]["owner"] == "dev-self"

    host.update_workspace("w1", sync_hosts=[])   # reopen
    rt.tick()
    ann = [p for k, p in client.sent if k == "ws:announce"]
    assert ann[-1]["open"] is True
    for w in rt._client_workers.get("hub1", []):
        w.conn.close()


def test_invite_auth_owner_only(host):
    from klanker.wssync import ws_invite_auth

    host.create("w1")
    assert not ws_invite_auth("dev-x", "w1")       # no owner -> refuse
    assert not ws_invite_auth("dev-x", "ghost")    # unknown ws -> refuse
    host.update_workspace(
        "w1", execution={"owner": "dev-a", "failover": "none"})
    assert ws_invite_auth("dev-a", "w1")
    assert not ws_invite_auth("dev-b", "w1")


def test_grant_apply_provisions_and_members(host):
    from klanker.wssync import ws_grant_apply

    ws_grant_apply("dev-new", "w1", "dev-owner")   # ws didn't exist
    ws = host.workspace("w1")
    assert set(ws.sync_hosts) == {"dev-new", "dev-owner"}
    assert (ws.execution or {}).get("owner") == "dev-owner"
    ws_grant_apply("dev-x", "w1", "")              # later grant
    assert set(host.workspace("w1").sync_hosts) == {
        "dev-new", "dev-owner", "dev-x"}
    assert (host.workspace("w1").execution
            or {}).get("owner") == "dev-owner"     # not displaced


def test_remote_dispatch_proxies_bound_session(
        host, monkeypatch, tmp_path):
    """session:host=B -> the turn POST forwards to
    <hub>/v1/remote/dev-B<path> under this device's credential (R5)."""
    import io
    import urllib.request
    from agents_store.db import connect
    from klanker.remote_dispatch import remote_turn_dispatch
    from klanker.session import bind_session

    ws = host.create("w1")
    _pair(host.dir)                                  # own id dev-self
    conn = connect(ws.dir / "store.db", check_same_thread=False)
    bind_session(conn, "ses_1", "rhost1")
    conn.close()

    calls = []

    class Resp:
        status = 200
        headers = {"Content-Type": "text/event-stream"}
        _data = [b"data: ok\n\n"]
        def read(self, n=-1):
            return self._data.pop(0) if self._data else b""

    def fake_urlopen(req, timeout=0, **kw):
        calls.append(req)
        return Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    import agents_relay.channel_client as _cc
    monkeypatch.setattr(_cc, "hub_token", lambda hub_id: "dev-tok")

    class Handler:
        headers = {"Accept": "text/event-stream"}
        wfile = io.BytesIO()
        def send_response(self, s): self.status = s
        def send_header(self, k, v): pass
        def end_headers(self): pass

    body = {"session": "ses_1", "workspace": "w1", "text": "hi"}
    assert remote_turn_dispatch(Handler(), "/v1/chat/stream", body)
    req = calls[0]
    assert req.full_url.endswith("/v1/remote/dev-rhost1/v1/chat/stream")
    assert req.headers["X-device-id"] == "dev-self"
    # unbound session stays local
    calls.clear()
    assert not remote_turn_dispatch(
        Handler(), "/v1/chat/stream", {"session": "free", "workspace": "w1"})
    assert calls == []


def test_reconcile_retires_worker_on_local_flip(host):
    from klanker.wssync import SyncRuntime

    ws = host.create("w1")
    _pair(host.dir)

    class FakeClient:
        hub_id = "hub1"
        device_id = "dev-self"
        def __init__(self):
            self.sent = []
            self.on_ws = self.on_op = self.on_ack = self.on_hello = None
        def send(self, kind, payload):
            self.sent.append((kind, payload))

    client = FakeClient()
    rt = SyncRuntime()
    rt.attach_client(client, [("w1", ws.dir)])
    host.update_workspace("w1", sync_policy="local")
    rt.tick()
    assert rt._client_workers["hub1"] == []
    assert any(k == "ws:revoke" for k, _ in client.sent)
