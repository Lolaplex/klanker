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


def test_invite_auth_admin_claims_ownerless_ws(host):
    """Web/API-created workspaces carry no execution.owner — nothing on
    the create path stamps it. The hub operator's first invite mint IS
    the explicit local share act (the klanker#146 hijack guard only
    closes OVER-WIRE claims), so the admin caller claims the ownerless
    ws as the host itself and mints; a device caller is still refused.
    Mirrors `klanker workspace invite` CLI semantics + the host_id
    owner `ws_grant_apply` records for `__admin__` invites."""
    from klanker.wssync import ws_invite_auth

    host.create("w1")
    # over the wire an ownerless ws is never claimable (klanker#146)
    assert not ws_invite_auth("dev-x", "w1")
    assert (host.workspace("w1").execution or {}).get("owner") in ("", None)
    # the hub operator (cookie/master-secret caller -> __admin__) claims
    assert ws_invite_auth("__admin__", "w1")
    assert (host.workspace("w1").execution or {}).get("owner") \
        == str(host.host_id())
    # claimed: foreign devices stay refused, the operator keeps minting
    assert not ws_invite_auth("dev-x", "w1")
    assert ws_invite_auth("__admin__", "w1")


def test_invite_auth_admin_ownerless_claim_preserves_execution(host):
    """The claim merge must not drop sibling execution keys."""
    from klanker.wssync import ws_invite_auth

    host.create("w1")
    host.update_workspace(
        "w1", execution={"failover": "standby", "lease_sec": 60})
    assert ws_invite_auth("__admin__", "w1")
    ex = host.workspace("w1").execution or {}
    assert ex.get("owner") == str(host.host_id())
    assert ex.get("failover") == "standby"
    assert ex.get("lease_sec") == 60


def test_invite_auth_admin_never_claims_foreign_owned(host):
    """An owner recorded for a device/peer is never displaced — and the
    admin is not the owner of a spoke-owned ws."""
    from klanker.wssync import ws_invite_auth

    host.create("w1")
    host.update_workspace(
        "w1", execution={"owner": "dev-spoke", "failover": "none"})
    assert not ws_invite_auth("__admin__", "w1")
    assert ws_invite_auth("dev-spoke", "w1")
    assert (host.workspace("w1").execution or {}).get("owner") == "dev-spoke"


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
    # urlsafe pair tokens contain '_'/'-' (secrets.token_urlsafe) — the
    # fragment credential class must admit them (klanker#154 gate catch)
    assert _parse_invite(
        "https://hub.example/#pair=_Ab3-xZ9") == \
        ("https://hub.example", "_Ab3-xZ9")
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
    """An already-paired device redeems under its own identity via
    channel_client.connect_hub: the stored Bearer token re-auths the
    grant (agents-relay#44 reuse — token=="" keeps device_id)."""
    import urllib.request
    from klanker import wshare
    from agents_relay import channel_client as _cc

    _pair(host.dir, device_id="dev-same")
    monkeypatch.setattr(_cc, "hub_token", lambda hid: "dev-tok")

    seen = {}

    class Resp:
        def read(self, n=-1):
            return b'{"ok": true, "mode": "ws", ' \
                   b'"device_id": "dev-same", ' \
                   b'"host_id": "hub1", "ws": "w9"}'

        def close(self):
            pass

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
    import json as _j
    body = _j.loads(req.data.decode())
    assert body["token"] == body["code"] == "ABCD-EFGH"
    # reuse keeps one hubs.json row — no second device minted
    rows = json.loads(
        (host.dir / "clients" / "hubs.json").read_text())["hubs"]
    assert list(rows) == ["hub1"]
    assert rows["hub1"]["device_id"] == "dev-same"


def test_join_new_pair_writes_row_and_vault(host, monkeypatch):
    """First-time join: redeem returns credentials -> hubs.json row +
    host-vault token (never printed)."""
    import urllib.request
    from klanker import wshare

    _pair(host.dir)  # paired to a DIFFERENT hub url
    seen = {}

    class Resp:
        def read(self, n=-1):
            return b'{"ok": true, "mode": "ws", ' \
                   b'"device_id": "dev-new", ' \
                   b'"token": "tok-secret", "host_id": "hub2", ' \
                   b'"ws": "w9"}'

        def close(self):
            pass

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


def test_join_live_serve_redeems_through_hub_connect(
        host, monkeypatch, capsys):
    """When `klanker serve` is live, join must redeem in THAT process —
    /v1/hub/connect persists and attaches the new channel where the
    SyncRuntime actually runs."""
    import urllib.request

    import agents_workspace as aw
    from agents_relay import channel_client as _cc
    from klanker import daemon, wshare

    monkeypatch.setattr(daemon, "discover_live_serve",
                        lambda: "http://local-serve")
    monkeypatch.setattr(aw, "resolve_relay_token", lambda: "relay-tok")
    forbidden = []
    monkeypatch.setattr(
        _cc, "connect_hub",
        lambda *a, **k: forbidden.append((a, k)) or {})
    calls = []

    class Resp:
        def read(self, n=-1):
            return (b'{"ok": true, "hub_id": "hub9", '
                    b'"device_id": "dev-b", "ws": "w9", '
                    b'"reused": false, "connected": true}')

        def close(self):
            pass

    def fake_urlopen(req, timeout=0, **kw):
        calls.append(req)
        return Resp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    rc = wshare.cmd_ws_join(Namespace(
        invite="http://hub/#pair=ABCD-EFGH", label="gate-B"))
    assert rc == 0
    assert forbidden == []
    assert len(calls) == 1
    req = calls[0]
    assert req.full_url == "http://local-serve/v1/hub/connect"
    assert req.headers["Authorization"] == "Bearer relay-tok"
    body = json.loads(req.data.decode())
    assert body == {"url": "http://hub", "code": "ABCD-EFGH",
                    "label": "gate-B"}
    assert "local serve attach requested" in capsys.readouterr().out


def test_join_live_serve_refusal_never_double_redeems(
        host, monkeypatch, capsys):
    """A hard local-serve refusal is terminal: the single-use invite may
    already be consumed, so the direct redeem path must not retry it."""
    import urllib.error
    import urllib.request

    import agents_workspace as aw
    from agents_relay import channel_client as _cc
    from klanker import daemon, wshare

    monkeypatch.setattr(daemon, "discover_live_serve",
                        lambda: "http://local-serve")
    monkeypatch.setattr(aw, "resolve_relay_token", lambda: "relay-tok")
    calls = []
    monkeypatch.setattr(_cc, "connect_hub",
                        lambda *a, **k: calls.append((a, k)) or {})
    boom = urllib.error.HTTPError("u", 502, "redeem failed", None, None)
    monkeypatch.setattr(
        urllib.request, "urlopen",
        lambda *a, **k: (_ for _ in ()).throw(boom))
    rc = wshare.cmd_ws_join(Namespace(
        invite="http://hub/#pair=ABCD-EFGH", label=""))
    assert rc == 2
    assert calls == []
    assert "local serve refused join" in capsys.readouterr().err


def test_invite_cli_over_real_loopback_hub_wire(host, monkeypatch, capsys):
    """Actual CLI path against a live HTTP hub double: /v1/hub/send must
    land (and be applied) before /v1/ws/invite, or the invite is 403."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from agents_relay import channel_client as _cc
    from klanker import wshare

    host.create("w1", label="shared")
    calls = []
    state = {"owner": ""}

    class Hub(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _json(self, payload, status=200):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            device = self.headers.get("X-Device-Id") or ""
            if self.path == "/v1/hub/send":
                calls.append("send")
                msg = body["msgs"][0]
                payload = msg["payload"]
                if payload.get("owner") == device:
                    state["owner"] = device
                self._json({"ok": True, "acked": 0, "malformed": 0})
                return
            if self.path == "/v1/ws/invite":
                calls.append("invite")
                if state["owner"] != device:
                    self._json({"error": "not the workspace owner"}, 403)
                    return
                self._json({
                    "code": "ABCD-EFGH", "expires_in": 60,
                    "pair_url": "http://hub/#kind=ws&ws=w1&pair=ABCD-EFGH"})
                return
            self._json({"error": "not found"}, 404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Hub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        _pair(host.dir, hub_id="hub1")
        p = host.dir / "clients" / "hubs.json"
        rows = json.loads(p.read_text())
        rows["hubs"]["hub1"]["hub_url"] = f"http://127.0.0.1:{port}"
        p.write_text(json.dumps(rows))
        monkeypatch.setattr(_cc, "hub_token", lambda hid: "tok")
        rc = wshare.cmd_ws_invite(
            Namespace(id="w1", hub="", json=True))
        assert rc == 0, capsys.readouterr().err
        out = json.loads(capsys.readouterr().out)
        assert out["code"] == "ABCD-EFGH"
        assert calls == ["send", "invite"]
        assert state["owner"] == "dev-self"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


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

    # execution merges (agents-workspace failclosed): explicit "" is
    # the only owner-clear, not an omitted key
    host.update_workspace(
        "w1", execution={"owner": "", "failover": "none"})
    host.update_workspace(
        "w1", sync_policy="synced", sync_hosts=["dev-self"])

    boom = urllib.error.HTTPError("u", 403, "m", None, None)
    calls = []

    class SendResp:
        def read(self, n=-1):
            return b'{"ok": true, "acked": 0, "malformed": 0}'

        def close(self):
            pass

    def fake_urlopen(req, timeout=0, **kw):
        calls.append(req.full_url)
        if req.full_url.endswith("/v1/hub/send"):
            return SendResp()
        raise boom

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    from agents_relay import channel_client as _cc
    monkeypatch.setattr(_cc, "hub_token", lambda hid: "tok")
    rc = wshare.cmd_ws_invite(Namespace(id="w1", hub="", json=False))
    assert rc == 2
    assert (host.workspace("w1").execution or {}).get("owner") in \
        (None, "")
    assert calls == ["http://hub/v1/hub/send",
                     "http://hub/v1/ws/invite"]
    assert "rejected the synchronized ownership announce" in \
        capsys.readouterr().err


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

    calls = []

    class Resp:
        def __init__(self, data):
            self._data = data

        def read(self, n=-1):
            return self._data

        def close(self):
            pass

    def fake_urlopen(req, timeout=0, **kw):
        calls.append(req)
        if req.full_url.endswith("/v1/hub/send"):
            return Resp(b'{"ok": true, "acked": 0, "malformed": 0}')
        return Resp(b'{"code": "ABCD-EFGH", "expires_in": 60, '
                    b'"pair_url": "http://hub/#pair=ABCD-EFGH"}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    rc = wshare.cmd_ws_invite(Namespace(id="w1", hub="", json=True))
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["code"] == "ABCD-EFGH" and out["ws"] == "w1"
    # Regression oracle: the ownership announce is upstreamed BEFORE the
    # single invite-mint POST; the hub cannot authorize the invite before
    # its workspace copy names our device as owner.
    assert [r.full_url for r in calls] == [
        "http://hub/v1/hub/send", "http://hub/v1/ws/invite"]
    sent = json.loads(calls[0].data.decode())
    frame = sent["msgs"][0]
    assert frame["kind"] == "ws:announce"
    assert frame["payload"]["ws"] == "w1"
    assert frame["payload"]["owner"] == "dev-self"
    assert frame["payload"]["sync_hosts"] == ["dev-self"]
    assert sent["ch"] == frame["ch"] == "dev-self"


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
