"""WsSync end-to-end: store tail -> op frames -> remote ingest -> ack.

Simulates the relay channel as in-memory queues — the wire format and
ack discipline are the contract under test, not the transport.
"""
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


@pytest.mark.skipif(
    not _ws_policy_supported(),
    reason="agents-workspace without sync_policy fields (feat/sync-policy)")
def test_sync_workspaces_excludes_local_policy(tmp_path, monkeypatch):
    """ws#43: sync_policy=local -> zero ops on the wire, ever."""
    monkeypatch.setenv("AGENTS_HOST_DIR", str(tmp_path / "host"))
    from agents_workspace import Host

    host = Host.from_env()
    host.dir.mkdir(parents=True, exist_ok=True)
    a = host.create("a")
    b = host.create("b")
    host.update_workspace(str(b.id), sync_policy="local")
    from klanker.wssync import sync_workspaces

    m = sync_workspaces()
    assert str(a.id) in m
    assert str(b.id) not in m


def test_msgs_project_and_sync(link, tmp_path):
    from klanker.msgsync import project_session

    class Ev:
        def __init__(self, ts, role, content):
            self.ts, self.type, self.session = ts, "message", "s1"
            self.metadata = {"role": role, "content": content}

    ws_a_dir = tmp_path / "ws_a"
    ws_a_dir.mkdir()
    project_session(link.a.conn, ws_a_dir, "s1", [
        Ev("2026-11-22T10:00:00Z", "user", "hallo welt"),
        Ev("2026-11-22T10:00:05Z", "assistant", "moin"),
    ])
    link.a.drain(); link.pump()
    view = link.b.store.view("msg:s1:000001")
    assert view["msg:role"] == "user"
    assert view["msg:text"] == "hallo welt"
    # B replays its own trace projection of the same event: origin
    # identity differs (proj:s1 on A vs B's own conn), so B's own tx —
    # but cursor-side dedupe keeps a re-drain silent either way.
    link.b.drain()
    link.pump()  # no frame storm


def test_session_attrs_seed(link):
    names = {r[0] for r in link.a.conn.execute("SELECT name FROM attr")}
    assert "session:host" in names
    assert "msg:text" in names
