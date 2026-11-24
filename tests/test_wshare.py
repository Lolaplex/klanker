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


def test_unshare_all_leaves_closed_set(host):
    from klanker import wshare

    host.create("w1")
    _pair(host.dir)
    wshare.cmd_ws_share(Namespace(id="w1", to="dev-b", open=False))
    # --to dev-self is refused as our own id; revoke dev-b only, then
    # the empty member set means CLOSED, not open.
    assert wshare.cmd_ws_unshare(
        Namespace(id="w1", to="dev-b", hub="")) == 0
    assert list(host.workspace("w1").sync_hosts or ()) == ["dev-self"]


def test_reconcile_announces_member_change(host):
    """`klanker ws share` edits workspace.json; the serve tick diffs the
    member set and emits ws:announce on the live channel."""
    from agents_store.db import connect  # noqa: F401  (dep sanity)
    from klanker.wssync import SyncRuntime

    ws = host.create("w1", label="shared")
    host.update_workspace("w1", sync_policy="synced")
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
    # first sight of a synced ws announces it (empty member set = closed)
    ann = [p for k, p in client.sent if k == "ws:announce"]
    assert ann and ann[0]["sync_hosts"] == []

    client.sent.clear()
    host.update_workspace(
        "w1", sync_policy="synced", sync_hosts=["dev-self", "dev-b"])
    rt.tick()
    ann = [p for k, p in client.sent if k == "ws:announce"]
    assert ann and ann[0]["sync_hosts"] == ["dev-b", "dev-self"]
    assert ann[0]["owner"] == "dev-self"

    host.update_workspace("w1", sync_hosts=[])   # back to closed
    rt.tick()
    ann = [p for k, p in client.sent if k == "ws:announce"]
    assert ann[-1]["sync_hosts"] == []
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
        read1 = read
        def close(self):
            pass

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
        def _write_json(self, payload, status):
            self.status = status
            self.json_body = payload

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


# ---------- klanker#147: strict invite parse + join identity ----------

def test_parse_invite_strict():
    from klanker.wshare import _parse_invite

    assert _parse_invite(
        "https://hub.example/#pair=ABCD-EFGH") == \
        ("https://hub.example", "ABCD-EFGH")
    assert _parse_invite("http://h:8787/#pair=zz12") == ("http://h:8787", "zz12")
    assert _parse_invite("ABCD-EFGH") == ("", "ABCD-EFGH")
    for bad in ("", "https://hub.example/pair=ABCD-EFGH",
                "https://hub.example#pair=", "ABCD",
                "https://hub.example/?token=ABCD-EFGH",
                "https://hub.example#pair=ABCD-EFGH&evil=1"):
        assert _parse_invite(bad) == ("", ""), bad


def test_join_malformed_refused(host, capsys):
    from klanker import wshare

    _pair(host.dir)
    rc = wshare.cmd_ws_join(
        Namespace(invite="https://hub/?token=abc", label=""))
    assert rc == 2
    assert "malformed" in capsys.readouterr().err


def test_join_reuses_existing_device(host, monkeypatch):
    """An already-paired device redeems under its own identity: Bearer
    token + X-Device-Id on the redeem call, no second hubs.json row."""
    import urllib.request
    from klanker import wshare
    from agents_relay import channel_client as _cc

    _pair(host.dir, device_id="dev-same")
    monkeypatch.setattr(_cc, "hub_token", lambda hid: "dev-tok")

    seen = {}

    class Resp:
        def read(self, n=-1):
            return b'{"ok": true, "device_id": "dev-same", ' \
                   b'"host_id": "hub1", "ws": "w9"}'

    def fake_urlopen(req, timeout=0, **kw):
        seen["req"] = req
        return Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    rc = wshare.cmd_ws_join(Namespace(
        invite="http://hub/#pair=ABCD-EFGH", label=""))
    assert rc == 0
    req = seen["req"]
    assert req.full_url == "http://hub/v1/pair/redeem"
    assert req.headers["Authorization"] == "Bearer dev-tok"
    assert req.headers["X-device-id"] == "dev-same"
    import json as _j
    body = _j.loads(req.data.decode())
    assert body["token"] == body["code"] == "ABCD-EFGH"


def test_join_new_pair_writes_row_and_vault(host, monkeypatch):
    """First-time join: redeem returns credentials -> hubs.json row +
    host-vault token (never printed)."""
    import urllib.request
    from klanker import wshare

    _pair(host.dir)  # paired to a DIFFERENT hub url
    seen = {}

    class Resp:
        def read(self, n=-1):
            return b'{"ok": true, "device_id": "dev-new", ' \
                   b'"token": "tok-secret", "host_id": "hub2", ' \
                   b'"ws": "w9"}'

    def fake_urlopen(req, timeout=0, **kw):
        seen["req"] = req
        return Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    rc = wshare.cmd_ws_join(Namespace(
        invite="http://hub2/#pair=ABCD-EFGH", label="laptop"))
    assert rc == 0
    rows = json.loads(
        (host.dir / "clients" / "hubs.json").read_text())["hubs"]
    assert rows["hub2"]["device_id"] == "dev-new"
    assert "tok-secret" not in json.dumps(rows)
    from agents_relay.channel_client import hub_token
    assert hub_token("hub2") == "tok-secret"
    assert "Authorization" not in seen["req"].headers


def test_invite_refused_on_non_tty(host, monkeypatch, capsys):
    """No --json + piped stdout = no credentials in a logfile."""
    from klanker import wshare

    host.create("w1")
    _pair(host.dir)
    monkeypatch.setattr("sys.stdout.isatty", lambda: False)
    rc = wshare.cmd_ws_invite(Namespace(id="w1", hub="", json=False))
    assert rc == 2
    assert "non-TTY" in capsys.readouterr().err


def test_invite_owner_refusal_and_rollback(host, monkeypatch, capsys):
    """Foreign-owner ws: refuse without touching execution. Own ws with
    hub-side failure: the pre-existing (empty) owner is restored."""
    import urllib.error
    import urllib.request
    from klanker import wshare

    ws = host.create("w1")
    host.update_workspace(
        "w1", execution={"owner": "dev-other", "failover": "none"})
    _pair(host.dir)
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    rc = wshare.cmd_ws_invite(Namespace(id="w1", hub="", json=False))
    assert rc == 2
    assert (host.workspace("w1").execution or {})["owner"] == "dev-other"

    host.update_workspace("w1", execution={"failover": "none"})
    host.update_workspace(
        "w1", sync_policy="synced", sync_hosts=["dev-self"])

    class Boom(Exception):
        code = 403
        def read(self):
            return b'{"error": "not owner"}'
    boom = urllib.error.HTTPError("u", 403, "m", None, None)
    monkeypatch.setattr(
        urllib.request, "urlopen",
        lambda *a, **k: (_ for _ in ()).throw(boom))
    from agents_relay import channel_client as _cc
    monkeypatch.setattr(_cc, "hub_token", lambda hid: "tok")
    rc = wshare.cmd_ws_invite(Namespace(id="w1", hub="", json=False))
    assert rc == 2
    assert (host.workspace("w1").execution or {}).get("owner") in \
        (None, "")
    assert "retry after a sync tick" in capsys.readouterr().err


def test_invite_json_on_non_tty(host, monkeypatch, capsys):
    import urllib.request
    from klanker import wshare
    from agents_relay import channel_client as _cc

    host.create("w1")
    host.update_workspace(
        "w1", sync_policy="synced", sync_hosts=["dev-self"],
        execution={"owner": "dev-self", "failover": "none"})
    _pair(host.dir)
    monkeypatch.setattr("sys.stdout.isatty", lambda: False)
    monkeypatch.setattr(_cc, "hub_token", lambda hid: "tok")

    class Resp:
        def read(self, n=-1):
            return b'{"code": "ABCD-EFGH", "expires_in": 60, ' \
                   b'"pair_url": "http://hub/#pair=ABCD-EFGH"}'

    monkeypatch.setattr(
        urllib.request, "urlopen", lambda *a, **k: Resp())
    rc = wshare.cmd_ws_invite(Namespace(id="w1", hub="", json=True))
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["code"] == "ABCD-EFGH" and out["ws"] == "w1"


def test_attach_new_hub_row_live(host, monkeypatch):
    """hubs.json row written after runtime start → tick spawns a live
    ChannelClient and fires CLIENT_HOOKS (klanker#147 no-restart)."""
    from klanker.wssync import SyncRuntime
    from agents_relay import channel_client as _cc

    rt = SyncRuntime()
    assert rt._clients == {}
    _pair(host.dir, device_id="dev-new", hub_id="hub2")

    spawned = []
    hooked = []

    class FakeClient:
        def __init__(self, hub_id):
            self.hub_id = hub_id
            spawned.append(hub_id)
            self.on_ws = self.on_op = self.on_ack = self.on_hello = None
        def run_forever(self):
            pass

    monkeypatch.setattr(_cc, "ChannelClient", FakeClient)
    hooks = []
    monkeypatch.setattr(_cc, "CLIENT_HOOKS", hooks)
    hooks.append(lambda c: hooked.append(c.hub_id))
    rt._attach_new_hubs()
    assert spawned == ["hub2"]
    assert hooked == ["hub2"]
    assert "hub2" in rt._clients


def test_pair_ws_shortcut(monkeypatch, capsys):
    """`klanker pair --ws <id>` routes into cmd_ws_invite."""
    from klanker import remotes_cli

    seen = {}
    monkeypatch.setattr(
        "klanker.wshare.cmd_ws_invite",
        lambda ns: seen.update(ns=ns) or 0)
    rc = remotes_cli.cmd_pair(Namespace(ws="w7", hub="hub9"))
    assert rc == 0
    assert seen["ns"].id == "w7" and seen["ns"].hub == "hub9"


def test_remote_pair_warns_without_channel(host, capsys, monkeypatch):
    """Legacy remote pair with no hub channel row → loud warning."""
    import urllib.request
    from klanker import remotes_cli

    class Resp:
        status = 200
        def read(self, n=-1):
            return (b'{"ok": true, "mode": "remote", "host_id": "h9",'
                    b' "token": "t"}')
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    monkeypatch.setattr(
        urllib.request, "urlopen", lambda *a, **k: Resp())
    rc = remotes_cli._cmd_remote_pair(Namespace(
        name="vps", url="http://h9:8787", code="ABCD-EFGH", id=""))
    assert rc == 0
    assert "without a hub channel" in capsys.readouterr().err


def test_invite_error_paths(host, monkeypatch, capsys):
    """no-hub / unknown-hub / missing-token / multi-hub all exit 2."""
    from klanker import wshare

    host.create("w1")
    monkeypatch.setattr("sys.stdout.isatty", lambda: True)
    assert wshare.cmd_ws_invite(
        Namespace(id="w1", hub="", json=False)) == 2        # no hub
    _pair(host.dir, hub_id="h1")
    clients = host.dir / "clients"
    import json as _j
    rows = _j.loads((clients / "hubs.json").read_text())
    rows["hubs"]["h2"] = {"device_id": "dev-s2",
                          "hub_url": "http://h2"}
    (clients / "hubs.json").write_text(_j.dumps(rows))
    assert wshare.cmd_ws_invite(
        Namespace(id="w1", hub="", json=False)) == 2        # ambiguous
    assert wshare.cmd_ws_invite(
        Namespace(id="w1", hub="ghost", json=False)) == 2   # unknown hub
    from agents_relay import channel_client as _cc
    monkeypatch.setattr(_cc, "hub_token", lambda hid: "")
    assert wshare.cmd_ws_invite(
        Namespace(id="w1", hub="h1", json=False)) == 2      # no token
    assert "no device token" in capsys.readouterr().err


def test_join_bare_code_needs_single_hub(host, capsys):
    from klanker import wshare

    # zero paired hubs → bare code cannot resolve
    assert wshare.cmd_ws_join(
        Namespace(invite="ABCD-EFGH", label="")) == 2
    err = capsys.readouterr().err
    assert "full invite URL" in err


def test_reconcile_retires_worker_on_local_flip(host):
    from klanker.wssync import SyncRuntime

    ws = host.create("w1")
    host.update_workspace(
        "w1", sync_policy="synced", sync_hosts=["dev-self"])
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
    host.update_workspace(
        "w1", sync_policy="local", sync_hosts=[])
    rt.tick()
    assert rt._client_workers["hub1"] == []
    assert any(k == "ws:revoke" for k, _ in client.sent)
