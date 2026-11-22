"""msgsync: trace message events -> msg:* datoms, idempotent projection."""
from dataclasses import dataclass

import pytest
from agents_store.db import connect
from agents_store.store import Store

from klanker.msgsync import list_sessions, project_session


@dataclass
class Ev:
    ts: str
    session: str
    type: str = "message"
    metadata: dict = None


def _ev(ts, role, content, session="s1"):
    return Ev(ts=ts, session=session,
              metadata={"role": role, "content": content})


@pytest.fixture
def ws(tmp_path):
    conn = connect(tmp_path / "store.db")
    yield tmp_path, conn
    conn.close()


def _msgs(store: Store, session: str) -> list[dict]:
    out = []
    for e, a, v in store.conn.execute(
            "SELECT e, a, v FROM v_current WHERE e LIKE 'msg:%' ORDER BY e, a"):
        out.append({"e": e, "a": a, "v": v})
    return out


def test_projects_user_and_assistant(ws):
    ws_dir, conn = ws
    events = [
        _ev("2026-11-22T10:00:00Z", "user", "hi"),
        _ev("2026-11-22T10:00:05Z", "assistant", "hello"),
    ]
    stats = project_session(conn, ws_dir, "s1", events)
    assert stats["projected"] == 2
    store = Store(conn, "test")
    view = store.view("msg:s1:000001")
    assert view["msg:role"] == "user"
    assert view["msg:text"] == "hi"
    assert view["msg:session"] == "s1"
    assert list_sessions(conn) == ["s1"]


def test_idempotent_replay(ws):
    ws_dir, conn = ws
    events = [_ev("2026-11-22T10:00:00Z", "user", "hi")]
    project_session(conn, ws_dir, "s1", events)
    stats = project_session(conn, ws_dir, "s1", events)  # full replay
    assert stats["projected"] == 0
    n = conn.execute("SELECT COUNT(*) FROM datom").fetchone()[0]
    assert n == 4  # one entity, 4 attrs, once


def test_incremental_append(ws):
    ws_dir, conn = ws
    project_session(conn, ws_dir, "s1",
                    [_ev("2026-11-22T10:00:00Z", "user", "one")])
    events = [
        _ev("2026-11-22T10:00:00Z", "user", "one"),
        _ev("2026-11-22T10:00:05Z", "assistant", "two"),
    ]
    stats = project_session(conn, ws_dir, "s1", events)
    assert stats["projected"] == 1
    store = Store(conn, "test")
    assert store.view("msg:s1:000002")["msg:text"] == "two"


def test_tool_role_and_empty_skipped(ws):
    ws_dir, conn = ws
    events = [
        _ev("2026-11-22T10:00:00Z", "tool", "call"),
        _ev("2026-11-22T10:00:01Z", "assistant", "  "),
        _ev("2026-11-22T10:00:02Z", "user", "real"),
    ]
    stats = project_session(conn, ws_dir, "s1", events)
    assert stats["projected"] == 1
    assert stats["skipped"] == 2


def test_hlc_matches_event_time(ws):
    ws_dir, conn = ws
    project_session(conn, ws_dir, "s1",
                    [_ev("2026-11-22T10:00:00Z", "user", "x")])
    row = conn.execute(
        "SELECT ord FROM datom WHERE e = 'msg:s1:000001' LIMIT 1").fetchone()
    assert row[0].startswith("1795341600000")  # epoch ms of the event ts
