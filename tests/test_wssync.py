"""WsSync end-to-end: store tail -> op frames -> remote ingest -> ack.

Simulates the relay channel as in-memory queues — the wire format and
ack discipline are the contract under test, not the transport.
"""
import json

import pytest
from agents_store import Change, connect
from agents_store.code_hash import code_hash_for_impl_ref
from agents_store.grant import grant
from agents_store.store import Store

from klanker.wssync import WsSync

_IMPL = "agents_store.wrappers.markdown.MarkdownWrapper"
_CODE_HASH = code_hash_for_impl_ref(_IMPL)


def _seed_grants(ws_dir):
    """test wrapper gets write grants before WsSync opens its own conn."""
    ws_dir.mkdir(parents=True, exist_ok=True)
    conn = connect(ws_dir / "store.db")
    conn.execute(
        "INSERT INTO wrapper (id, namespace, impl_ref) VALUES ('test', 'test', ?)",
        (_IMPL,))
    cert = conn.execute(
        "INSERT INTO certificate (tier, subject, ref, result, code_hash)"
        " VALUES ('witness', 'wrapper:test', 't', 'pass', ?)",
        (_CODE_HASH,)).lastrowid
    for a in ("title", "status"):
        grant(conn, "test", a, cert)
    conn.close()


class FakeLink:
    """Two WsSync workers (spoke A <-> hub B) on one workspace."""

    def __init__(self, ws_id, dir_a, dir_b):
        _seed_grants(dir_a)
        _seed_grants(dir_b)
        self.a2b, self.b2a = [], []
        self.a = WsSync(ws_id, dir_a, "nodeA", "hub",
                        lambda k, p: self.a2b.append((k, p)),
                        origin_only=True)
        self.b = WsSync(ws_id, dir_b, "nodeB", "nodeA",
                        lambda k, p: self.b2a.append((k, p)))

    def pump(self):
        """Deliver every queued frame until the link is silent."""
        rounds = 0
        while self.a2b or self.b2a:
            assert rounds < 10, "frame storm — ack/echo loop"
            rounds += 1
            a2b, self.a2b = self.a2b, []
            b2a, self.b2a = self.b2a, []
            for kind, p in a2b:
                getattr(self.b, f"on_{kind}")(p)
            for kind, p in b2a:
                getattr(self.a, f"on_{kind}")(p)


@pytest.fixture
def link(tmp_path):
    fl = FakeLink("ws1", tmp_path / "a", tmp_path / "b")
    yield fl
    fl.a.conn.close()
    fl.b.conn.close()


def _view(store: Store, e: str) -> dict:
    return store.view(e)


def test_spoke_to_hub_convergence(link):
    res = link.a.store.transact(
        [Change(e=None, a="title", v="hello")], wrapper="test")
    e = res.entity
    link.a.drain()
    link.pump()
    assert _view(link.b.store, e)["title"] == "hello"
    # B acked the batch cursor; A's cursor moved only on ack
    assert link.a.book.acked("hub") > 0


def test_hub_to_spoke_convergence(link):
    res = link.b.store.transact(
        [Change(e=None, a="status", v="open")], wrapper="test")
    e = res.entity
    link.b.drain()
    link.pump()
    assert _view(link.a.store, e)["status"] == "open"


def test_bidirectional_no_echo_storm(link):
    ea = link.a.store.transact(
        [Change(e=None, a="title", v="a")], wrapper="test").entity
    link.a.drain()
    link.pump()
    # B holds A's op (origin preserved); draining B must NOT re-emit it
    # back to A — exclude_origin drops it. Only B's ack frame should fly.
    link.b.drain()
    link.pump()  # would assert-frame-storm if echo leaked
    assert _view(link.b.store, ea)["title"] == "a"


def test_lost_frame_redelivers_on_next_drain(link):
    res = link.a.store.transact(
        [Change(e=None, a="title", v="retry")], wrapper="test")
    link.a.drain()
    link.a2b.clear()            # simulate transport loss before ingest
    link.b.drain(); link.pump()
    assert link.a.book.acked("hub") == 0   # no ack arrived
    link.a.drain()                         # redelivers from acked floor
    link.pump()
    assert _view(link.b.store, res.entity)["title"] == "retry"


def test_scrub_tombstone_propagates(link):
    from agents_store.scrub import scrub_entity
    res = link.a.store.transact(
        [Change(e=None, a="title", v="gone")], wrapper="test")
    e = res.entity
    link.a.drain(); link.pump()
    assert _view(link.b.store, e)["title"] == "gone"
    scrub_entity(link.a.conn, e, reason="test", ord_key=link.a.store._clock.tick())
    link.a.conn.commit()
    link.a.drain(); link.pump()
    assert _view(link.b.store, e) == {}


def _ws_policy_supported() -> bool:
    """agents-workspace feat/sync-policy fields present?"""
    import inspect

    from agents_workspace import Host

    return "sync_policy" in inspect.signature(
        Host.update_workspace).parameters


_POLICY = pytest.mark.skipif(
    not _ws_policy_supported(),
    reason="agents-workspace without sync_policy fields (feat/sync-policy)")


@_POLICY
def test_sync_workspaces_excludes_local_policy(tmp_path, monkeypatch):
    """ws#43: sync_policy=local -> zero ops on the wire, ever."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    a = host.create("a")
    b = host.create("b")
    # W05: create defaults to local — synced must be explicit, and
    # local + non-empty sync_hosts raises.
    host.update_workspace(str(a.id), sync_policy="synced")
    from klanker.wssync import sync_workspaces

    m = sync_workspaces()
    assert str(a.id) in m
    assert str(b.id) not in m
    assert m[str(a.id)]["hosts"] == frozenset()


@_POLICY
def test_sync_workspaces_host_allowlist(tmp_path, monkeypatch):
    """sync_hosts narrows hub fan-out to the listed devices (ws#43)."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    a = host.create("a")
    host.update_workspace(
        str(a.id), sync_policy="synced", sync_hosts=["dev-b"])
    from klanker.wssync import sync_workspaces

    m = sync_workspaces()
    assert m[str(a.id)]["hosts"] == frozenset({"dev-b"})


def test_hub_drops_ops_from_non_member_device(tmp_path, monkeypatch):
    """R1 write ACL: ops for a ws from a device outside sync_hosts are
    dropped before ingest — no worker, no datoms, no fan-out."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    ws = host.create("ws1")
    hub_dir = ws.dir
    _seed_grants(hub_dir)
    host.update_workspace(
        "ws1", sync_policy="synced", sync_hosts=["dev-a", "dev-b"])
    rt = SyncRuntime()

    class FakeHub:
        def __init__(self):
            self.op_handler = None
            self.published = []
        def set_op_handler(self, h): self.op_handler = h
        def set_ack_handler(self, h): pass
        def set_ws_handler(self, h): pass
        def set_connect_handler(self, h): pass
        def connected_devices(self):
            return ["dev-a", "dev-b", "evil"]
        def publish(self, device_id, kind, payload):
            self.published.append((device_id, kind, payload))

    hub = FakeHub()
    rt.attach_hub(
        hub,
        {"ws1": {"dir": hub_dir, "hosts": frozenset({"dev-a", "dev-b"})}},
        "hubNode")

    # mint a real op frame on a foreign store, sent by a non-member
    src_dir = tmp_path / "src"
    _seed_grants(src_dir)
    src = WsSync("ws1", src_dir, "evilNode", "hub",
                 lambda k, p: None, local_node="evilNode")
    res = src.store.transact([Change(e=None, a="title", v="forged")],
                             wrapper="test")
    frames = []
    src._send = lambda kind, p: frames.append((kind, p))
    src.drain()
    op_payload = next(p for k, p in frames if k == "op")

    hub.op_handler("evil", op_payload)
    assert ("ws1", "evil") not in rt._hub_workers   # no worker spawned
    hconn = connect(hub_dir / "store.db", check_same_thread=False)
    assert Store(hconn).view(res.entity) == {}
    assert [p for p in hub.published if p[1] == "op"] == []

    # same op from a member: ingested on the hub, then fanned out as a
    # hub-local batch (never the spoke's raw batch_cursor, klanker#146)
    hub.op_handler("dev-a", op_payload)
    assert Store(hconn).view(res.entity) != {}
    fan = [p for p in hub.published
           if p[0] == "dev-b" and p[1] == "op"]
    assert fan, "member worker never drained to the other member"
    # the forwarded frame is a NEW hub-minted batch (own batch_cursor),
    # never the spoke's raw payload object (klanker#146)
    assert fan[0][2] is not op_payload
    assert fan[0][2]["envelopes"] == op_payload["envelopes"]
    # the spoke itself never gets its own op echoed back
    assert [p for p in hub.published
            if p[0] == "dev-a" and p[1] == "op"
            and p[2].get("envelopes") == op_payload.get("envelopes")] == []
    hconn.close()


class _FakeShareHub:
    """Minimal hub channel double for ws-share control frames."""

    def __init__(self):
        self.ws_handler = None
        self.op_handler = None
        self.published = []   # (device, kind, payload)

    def set_op_handler(self, h): self.op_handler = h
    def set_ack_handler(self, h): pass
    def set_ws_handler(self, h): self.ws_handler = h
    def broadcast(self, kind, payload, skip=frozenset()): pass
    def connected_devices(self): return []
    def publish(self, device_id, kind, payload):
        self.published.append((device_id, kind, payload))


@_POLICY
def test_hub_announce_provisions_and_fans_out(tmp_path, monkeypatch):
    """ws:announce from a device provisions the ws on the hub, records
    ownership, and pushes announce+backfill to newly added members."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    rt = SyncRuntime()
    hub = _FakeShareHub()
    rt.attach_hub(hub, {}, "hubNode")

    hub.ws_handler("dev-a", "ws:announce", {
        "ws": "w1", "label": "shared-ws",
        "sync_hosts": ["dev-b"], "seq": 1})
    ws = host.workspace("w1")
    assert ws.dir.is_dir()                       # provisioned on hub
    assert set(ws.sync_hosts) == {"dev-a", "dev-b"}
    assert (ws.execution or {}).get("owner") == "dev-a"
    assert ("dev-b", "ws:announce") in [
        (d, k) for d, k, _ in hub.published]
    assert ("w1", "dev-b") in rt._hub_workers    # backfill worker exists
    # owner cannot be displaced by another device
    hub.ws_handler("dev-b", "ws:announce", {
        "ws": "w1", "sync_hosts": ["dev-b", "evil"], "seq": 2})
    ws = host.workspace("w1")
    assert set(ws.sync_hosts) == {"dev-a", "dev-b"}   # unchanged


@_POLICY
def test_hub_announce_revokes_removed_member(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    rt = SyncRuntime()
    hub = _FakeShareHub()
    rt.attach_hub(hub, {}, "hubNode")

    hub.ws_handler("dev-a", "ws:announce", {
        "ws": "w1", "sync_hosts": ["dev-b", "dev-c"], "seq": 1})
    hub.published.clear()
    hub.ws_handler("dev-a", "ws:announce", {
        "ws": "w1", "sync_hosts": ["dev-b"], "seq": 2})
    assert ("dev-c", "ws:revoke") in [
        (d, k) for d, k, _ in hub.published]
    assert set(host.workspace("w1").sync_hosts) == {"dev-a", "dev-b"}


@_POLICY
def test_spoke_announce_provisions_and_revoke_freezes(
        tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    rt = SyncRuntime()

    class FakeClient:
        hub_id = "hub1"
        device_id = "dev-b"
        def __init__(self):
            self.sent = []
            self.on_ws = None
            self.on_op = None
            self.on_ack = None
            self.on_hello = None
        def send(self, kind, payload): self.sent.append((kind, payload))

    client = FakeClient()
    rt.attach_client(client, [])       # spoke with no local ws yet
    client.on_ws("ws:announce", {
        "ws": "w1", "label": "shared-ws", "owner": "dev-a",
        "sync_hosts": ["dev-a", "dev-b"], "seq": 1})
    assert host.workspace_exists("w1")
    workers = rt._client_workers["hub1"]
    assert [w.ws_id for w in workers] == ["w1"]
    workers[0].conn.close()
    client.on_ws("ws:revoke", {"ws": "w1", "seq": 2})
    assert rt._client_workers["hub1"] == []
    assert host.workspace("w1").sync_policy == "local"


def _local_origins_supported() -> bool:
    import inspect

    from agents_store import ingest as _ing

    return "local_origins" in inspect.signature(_ing.ops_since).parameters


@pytest.mark.skipif(
    not _local_origins_supported(),
    reason="agents-store without ops_since(local_origins) "
           "(feat/ingest-local-origins)")
def test_msgs_project_and_sync(link, tmp_path):
    from klanker.msgsync import message_entity, project_session

    class Ev:
        def __init__(self, ts, role, content):
            self.ts, self.type, self.session = ts, "message", "s1"
            self.metadata = {"role": role, "content": content}

    ws_a_dir = tmp_path / "ws_a"
    ws_a_dir.mkdir()
    project_session(link.a.conn, ws_a_dir, "s1", [
        Ev("2026-11-22T10:00:00Z", "user", "hallo welt"),
        Ev("2026-11-22T10:00:05Z", "assistant", "moin"),
    ], node=link.a.local_node)
    link.a.drain(); link.pump()
    view = link.b.store.view(
        message_entity("s1", "2026-11-22T10:00:00Z", "user", "hallo welt"))
    assert view["msg:role"] == "user"
    assert view["msg:text"] == "hallo welt"
    link.b.drain()
    link.pump()  # no frame storm


@pytest.mark.skipif(
    not _local_origins_supported(),
    reason="agents-store without ops_since(local_origins) "
           "(feat/ingest-local-origins)")
def test_peer_projection_not_echoed_by_spoke(link, tmp_path):
    """Hub-side projection (proj@nodeB) reaches spoke A; A's origin_only
    drain must not treat it as local and echo it back."""
    from klanker.msgsync import project_session

    class Ev:
        def __init__(self, ts, role, content):
            self.ts, self.type, self.session = ts, "message", "s9"
            self.metadata = {"role": role, "content": content}

    project_session(link.b.conn, tmp_path, "s9", [
        Ev("2026-11-22T11:00:00Z", "user", "from hub")],
        node=link.b.local_node)
    link.b.drain(); link.pump()
    link.a2b.clear()
    link.a.drain()
    assert [k for k, _ in link.a2b if k == "op"] == []


def test_tick_projects_once_per_ws_dir_and_drains(tmp_path):
    from klanker.msgsync import session_messages
    from klanker.wssync import SyncRuntime

    rt = SyncRuntime()
    ws_dir = tmp_path / "ws"
    (ws_dir / "traces").mkdir(parents=True)
    (ws_dir / "traces" / "2026-11-22.jsonl").write_text(json.dumps({
        "ts": "2026-11-22T10:00:00Z", "session": "s1", "type": "message",
        "metadata": {"role": "user", "content": "hi"}}) + "\n")
    sent = []
    w1 = WsSync("ws1", ws_dir, "nodeA", "dev1",
                lambda k, p: sent.append(("dev1", k)), local_node="nodeA")
    w2 = WsSync("ws1", ws_dir, "nodeA", "dev2",
                lambda k, p: sent.append(("dev2", k)), local_node="nodeA")
    rt._hub_workers = {("ws1", "dev1"): w1, ("ws1", "dev2"): w2}
    rt.tick()
    assert [m["text"] for m in session_messages(w1.conn, "s1")] == ["hi"]
    n = w1.conn.execute(
        "SELECT COUNT(*) FROM tx WHERE origin_actor = 'proj@nodeA:s1'"
    ).fetchone()[0]
    assert n == 1
    assert ("dev1", "op") in sent and ("dev2", "op") in sent
    w1.conn.close(); w2.conn.close()


def test_session_attrs_seed(link):
    names = {r[0] for r in link.a.conn.execute("SELECT name FROM attr")}
    assert "session:host" in names
    assert "msg:text" in names


# ---------- klanker#146 hardening ------------------------------------------


@_POLICY
def test_hub_announce_rejects_unowned_existing_ws(tmp_path, monkeypatch):
    """Hijack guard: a ws that exists on the hub with no recorded owner
    can never be claimed over the wire — explicit share required."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    ws = host.create("w1")
    host.update_workspace("w1", sync_policy="synced",
                          sync_hosts=["localdev"])
    rt = SyncRuntime()
    hub = _FakeShareHub()
    rt.attach_hub(hub, {"w1": {"dir": ws.dir,
                             "hosts": frozenset({"localdev"})}},
                  "hubNode")
    hub.ws_handler("dev-x", "ws:announce", {
        "ws": "w1", "sync_hosts": ["dev-x"], "seq": 1})
    ws = host.workspace("w1")
    assert (ws.execution or {}).get("owner") in (None, "")
    assert "dev-x" not in (ws.sync_hosts or ())
    assert ("w1", "dev-x") not in rt._hub_workers


@_POLICY
def test_hub_announce_rejects_local_policy_ws(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    host.create("w1")  # default: local
    rt = SyncRuntime()
    hub = _FakeShareHub()
    rt.attach_hub(hub, {}, "hubNode")
    hub.ws_handler("dev-a", "ws:announce", {
        "ws": "w1", "sync_hosts": ["dev-a"], "seq": 1})
    ws = host.workspace("w1")
    assert ws.sync_policy == "local"
    assert not (ws.sync_hosts or ())
    assert ("w1", "dev-a") not in rt._hub_workers


@_POLICY
def test_live_acl_evicts_worker_on_member_removal(tmp_path, monkeypatch):
    """Removing a device from sync_hosts must kill its hub worker — a
    stale worker would keep acking/ingesting for a revoked member."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    ws = host.create("w1")
    host.update_workspace(
        "w1", sync_policy="synced", sync_hosts=["dev-a", "dev-b"],
        execution={"owner": "dev-a"})
    rt = SyncRuntime()
    hub = _FakeShareHub()
    rt.attach_hub(hub, {"w1": {"dir": ws.dir,
                             "hosts": frozenset({"dev-a", "dev-b"})}},
                  "hubNode")
    w = rt._hub_worker("dev-b", "w1")
    assert w is not None
    host.update_workspace("w1", sync_hosts=["dev-a"])
    assert rt._hub_worker("dev-b", "w1") is None  # live gate, no spawn
    # reconcile sweep also evicts the stale worker entry
    rt._hub_workers[("w1", "dev-b")] = w
    rt._reconcile_shares()
    assert ("w1", "dev-b") not in rt._hub_workers


def test_shared_peerbook_per_workspace(tmp_path):
    """Two workers on the same ws dir share one PeerBook — sibling
    instances clobbered each other's acked cursors (klanker#146)."""
    ws_dir = tmp_path / "ws"
    rt = __import__("klanker.wssync", fromlist=["SyncRuntime"]).SyncRuntime()
    w1 = WsSync("w1", ws_dir, "n", "dev-a", lambda k, p: None,
                book=rt._book_for(ws_dir))
    w2 = WsSync("w1", ws_dir, "n", "dev-b", lambda k, p: None,
                book=rt._book_for(ws_dir))
    assert w1.book is w2.book
    w1.close()
    w2.close()


@_POLICY
def test_share_state_survives_restart(tmp_path, monkeypatch):
    """Persisted share state: a runtime restart must not re-announce
    member sets it already delivered (klanker#146)."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host
    from klanker.wssync import SyncRuntime

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    rt = SyncRuntime()
    rt._announce_sent[("dev-a", "w1")] = frozenset({"dev-a", "dev-b"})
    rt._share_state[("spoke", "hub1", "w1")] = frozenset({"dev-a"})
    rt._save_share_state()
    rt2 = SyncRuntime()
    assert rt2._announce_sent[("dev-a", "w1")] == {"dev-a", "dev-b"}
    assert rt2._share_state[("spoke", "hub1", "w1")] == {"dev-a"}


def test_tick_sec_clamped(monkeypatch):
    monkeypatch.setenv("KLANKER_SYNC_TICK_SEC", "0.01")
    import importlib

    import klanker.wssync as wsmod
    try:
        importlib.reload(wsmod)
        assert wsmod.TICK_SEC >= 1.0
    finally:
        monkeypatch.delenv("KLANKER_SYNC_TICK_SEC", raising=False)
        importlib.reload(wsmod)


def test_on_op_never_raises_on_channel_thread(tmp_path):
    """A malformed op frame must not propagate into the channel reader
    thread — it logs and swallows."""
    w = WsSync("w1", tmp_path / "ws", "n", "peer",
               lambda k, p: None)
    w.on_op({"envelopes": [{"v": 1, "actor": "x", "seq": "notanint",
                            "datoms": "garbage"}]})
    w.on_op({"envelopes": "notalist"})
    w.close()
