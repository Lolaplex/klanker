"""msgsync: trace message events -> msg:* datoms, host-safe + incremental."""
import json
from dataclasses import dataclass

import pytest
from agents_store.db import connect
from agents_store.ingest import ingest, ops_since

from klanker.msgsync import (
    ensure_domain, list_sessions, message_entity, next_seq,
    project_session, project_traces, session_messages)


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


def _view(conn, e):
    return {a: v for a, v in conn.execute(
        "SELECT a, v FROM v_current WHERE e = ?", (e,))}


def _ship(src, dst, src_node):
    """Distributor pull: every op of src into dst (origin identity kept)."""
    for op in ops_since(src, 0):
        ingest(dst, op["origin_actor"] or src_node, op["origin_seq"],
               op["hlc"], [(d["e"], d["a"], d["v"], d["added"])
                           for d in op["datoms"]])


def test_projects_user_and_assistant(ws):
    ws_dir, conn = ws
    events = [
        _ev("2026-11-22T10:00:00Z", "user", "hi"),
        _ev("2026-11-22T10:00:05Z", "assistant", "hello"),
    ]
    stats = project_session(conn, ws_dir, "s1", events, node="hostA")
    assert stats["projected"] == 2
    view = _view(conn, message_entity("s1", "2026-11-22T10:00:00Z", "user", "hi"))
    assert view["msg:role"] == "user"
    assert view["msg:text"] == "hi"
    assert view["msg:session"] == "s1"
    assert view["msg:host"] == "hostA"
    assert list_sessions(conn) == ["s1"]


def test_idempotent_replay(ws):
    ws_dir, conn = ws
    events = [_ev("2026-11-22T10:00:00Z", "user", "hi")]
    project_session(conn, ws_dir, "s1", events, node="hostA")
    stats = project_session(conn, ws_dir, "s1", events, node="hostA")
    assert stats["projected"] == 0
    n = conn.execute("SELECT COUNT(*) FROM datom").fetchone()[0]
    # one entity x 5 attrs, once + session:title/last_active refresh
    assert n == 7


def test_tool_role_missing_role_and_empty_skipped(ws):
    ws_dir, conn = ws
    events = [
        _ev("2026-11-22T10:00:00Z", "tool", "call"),
        _ev("2026-11-22T10:00:01Z", "assistant", "  "),
        Ev("2026-11-22T10:00:02Z", "s1", metadata={"content": "no role"}),
        _ev("2026-11-22T10:00:03Z", "user", "real"),
    ]
    stats = project_session(conn, ws_dir, "s1", events, node="hostA")
    assert stats == {"projected": 1, "skipped": 3}


def test_hlc_matches_event_time(ws):
    ws_dir, conn = ws
    project_session(conn, ws_dir, "s1",
                    [_ev("2026-11-22T10:00:00Z", "user", "x")], node="hostA")
    e = message_entity("s1", "2026-11-22T10:00:00Z", "user", "x")
    row = conn.execute(
        "SELECT ord FROM datom WHERE e = ? LIMIT 1", (e,)).fetchone()
    assert row[0].startswith("1795341600000")  # epoch ms of the event ts


def test_host_switch_never_drops_messages(tmp_path):
    """Session runs on A (prompt 1), then on B (prompt 2): each host's
    trace holds only its own part. Both parts must survive on every
    host -- local ordinals used to collide on msg:<sid>:000001."""
    a = connect(tmp_path / "a.db")
    b = connect(tmp_path / "b.db")
    hub = connect(tmp_path / "hub.db")
    for d in ("wa", "wb", "wh"):
        (tmp_path / d).mkdir()
    project_session(a, tmp_path / "wa", "s1", [
        _ev("2026-11-22T10:00:00Z", "user", "q1"),
        _ev("2026-11-22T10:00:05Z", "assistant", "a1")], node="hostA")
    project_session(b, tmp_path / "wb", "s1", [
        _ev("2026-11-22T10:01:00Z", "user", "q2"),
        _ev("2026-11-22T10:01:05Z", "assistant", "a2")], node="hostB")
    project_session(hub, tmp_path / "wh", "s1", [], node="hub")  # seed attrs
    _ship(a, hub, "hostA")
    _ship(b, hub, "hostB")
    _ship(hub, a, "hub")
    _ship(hub, b, "hub")
    for conn in (a, b, hub):
        texts = [m["text"] for m in session_messages(conn, "s1")]
        assert texts == ["q1", "a1", "q2", "a2"]
        hosts = [m["host"] for m in session_messages(conn, "s1")]
        assert hosts == ["hostA", "hostA", "hostB", "hostB"]


def test_same_event_on_two_hosts_is_one_entity(tmp_path):
    a = connect(tmp_path / "a.db")
    b = connect(tmp_path / "b.db")
    ev = [_ev("2026-11-22T10:00:00Z", "user", "copied trace line")]
    project_session(a, tmp_path, "s1", ev, node="hostA")
    project_session(b, tmp_path, "s1", ev, node="hostB")
    _ship(a, b, "hostA")
    assert len(session_messages(b, "s1")) == 1


def test_seq_continues_from_store_not_cursor(ws):
    ws_dir, conn = ws
    project_session(conn, ws_dir, "s1",
                    [_ev("2026-11-22T10:00:00Z", "user", "one")], node="h")
    (ws_dir / "msg_cursors.json").unlink(missing_ok=True)
    # seq 1 msg tx + seq 2 session:title/last_active refresh tx
    assert next_seq(conn, "proj@h:s1") == 3
    stats = project_session(conn, ws_dir, "s1", [
        _ev("2026-11-22T10:00:00Z", "user", "one"),
        _ev("2026-11-22T10:00:09Z", "user", "two")], node="h")
    assert stats["projected"] == 1  # "two" not dropped by a reused seq
    assert [m["text"] for m in session_messages(conn, "s1")] == ["one", "two"]


def _append(path, ev: dict):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(ev) + "\n")


def _line(ts, role, content, session="s1", type_="message"):
    return {"ts": ts, "session": session, "type": type_,
            "metadata": {"role": role, "content": content}}


def test_project_traces_incremental(ws):
    ws_dir, conn = ws
    tdir = ws_dir / "traces"
    tdir.mkdir()
    day = tdir / "2026-11-22.jsonl"
    _append(day, _line("2026-11-22T10:00:00Z", "user", "hi"))
    _append(day, _line("2026-11-22T10:00:01Z", "x", "tool", type_="tool_call"))
    _append(day, _line("2026-11-22T10:00:02Z", "assistant", "yo"))
    s1 = project_traces(conn, ws_dir, node="h")
    assert s1["projected"] == 2
    off = json.loads((ws_dir / "msg_cursors.json").read_text())["files"]
    assert off["2026-11-22.jsonl"] == day.stat().st_size
    # nothing new -> nothing parsed
    assert project_traces(conn, ws_dir, node="h")["files"] == 0
    # partial line (writer mid-append) is not consumed yet
    with open(day, "a", encoding="utf-8") as f:
        f.write(json.dumps(_line("2026-11-22T10:00:03Z", "user", "more"))[:20])
    assert project_traces(conn, ws_dir, node="h")["projected"] == 0
    with open(day, "a", encoding="utf-8") as f:
        f.write(json.dumps(_line("2026-11-22T10:00:03Z", "user", "more"))[20:] + "\n")
    s3 = project_traces(conn, ws_dir, node="h")
    assert s3["projected"] == 1
    assert [m["text"] for m in session_messages(conn, "s1")] == ["hi", "yo", "more"]


def test_project_traces_shrunk_file_replays_safely(ws):
    ws_dir, conn = ws
    tdir = ws_dir / "traces"
    tdir.mkdir()
    day = tdir / "2026-11-22.jsonl"
    _append(day, _line("2026-11-22T10:00:00Z", "user", "hi"))
    _append(day, _line("2026-11-22T10:00:02Z", "assistant", "yo"))
    project_traces(conn, ws_dir, node="h")
    day.write_text(json.dumps(_line("2026-11-22T10:00:00Z", "user", "hi")) + "\n")
    s = project_traces(conn, ws_dir, node="h")
    assert s["projected"] == 0 and s["skipped"] == 1


def _frame(ts, first, last, kind="undo", content="", session="s1"):
    return Ev(ts=ts, session=session, type="frame", metadata={
        "kind": kind,
        "summarized_from": {"first_ts": first, "last_ts": last},
        "content": content, "source": "session-op"})


def test_undo_frame_marks_covered_turn_deleted(ws):
    ws_dir, conn = ws
    project_session(conn, ws_dir, "s1", [
        _ev("2026-11-22T10:00:00Z", "user", "turn one"),
        _ev("2026-11-22T10:00:05Z", "assistant", "answer one"),
        _ev("2026-11-22T10:01:00Z", "user", "turn two"),
        _ev("2026-11-22T10:01:05Z", "assistant", "answer two")], node="h")
    project_session(conn, ws_dir, "s1", [
        _frame("2026-11-22T10:01:05Z",
               "2026-11-22T10:01:00Z", "2026-11-22T10:01:05Z")], node="h")
    msgs = session_messages(conn, "s1")
    assert [m["text"] for m in msgs] == ["turn one", "answer one"]
    assert list_sessions(conn) == ["s1"]
    view = _view(conn, "session:s1")
    assert view["session:title"] == "turn one"
    assert view["session:last_active"] == "2026-11-22T10:00:05Z"


def test_all_msgs_covered_drops_session(ws):
    ws_dir, conn = ws
    project_session(conn, ws_dir, "s1", [
        _ev("2026-11-22T10:00:00Z", "user", "only turn")], node="h")
    project_session(conn, ws_dir, "s1", [
        _frame("2026-11-22T10:00:00Z",
               "2026-11-22T10:00:00Z", "2026-11-22T10:00:00Z")], node="h")
    assert session_messages(conn, "s1") == []
    assert list_sessions(conn) == []


def test_covering_frame_retires_earlier_frame(ws):
    ws_dir, conn = ws
    project_session(conn, ws_dir, "s1", [
        _ev("2026-11-22T10:00:00Z", "user", "a"),
        _frame("2026-11-22T10:00:05Z",
               "2026-11-22T10:00:05Z", "2026-11-22T10:00:05Z",
               kind="compaction", content="first summary")], node="h")
    frame1 = [e for (e,) in conn.execute(
        "SELECT e FROM v_current WHERE a = 'frame:session'")][0]
    # a wider frame whose span contains frame1's ts retires it, and its
    # summary msg (msg:frame_id -> frame1) is superseded with it
    project_session(conn, ws_dir, "s1", [
        _frame("2026-11-22T10:01:00Z",
               "2026-11-22T10:00:00Z", "2026-11-22T10:01:00Z",
               kind="compaction", content="wider summary")], node="h")
    assert _view(conn, frame1)["frame:retired"] == "true"
    msgs = session_messages(conn, "s1")
    assert [m["text"] for m in msgs] == ["wider summary"]


def test_deleted_state_ships_to_peer(tmp_path):
    a = connect(tmp_path / "a.db")
    b = connect(tmp_path / "b.db")
    (tmp_path / "wa").mkdir()
    (tmp_path / "wb").mkdir()
    # host B registers the domain before remote ops land (WsSync does this
    # on open): ingest refuses unknown attrs.
    ensure_domain(b)
    events = [
        _ev("2026-11-22T10:00:00Z", "user", "turn one"),
        _ev("2026-11-22T10:00:05Z", "assistant", "answer one"),
        _ev("2026-11-22T10:01:00Z", "user", "turn two"),
        _frame("2026-11-22T10:01:00Z",
               "2026-11-22T10:01:00Z", "2026-11-22T10:01:00Z")]
    project_session(a, tmp_path / "wa", "s1", events, node="hostA")
    _ship(a, b, "hostA")
    # Host B only ever saw ops: the covered "turn two" must not resurrect.
    assert [m["text"] for m in session_messages(b, "s1")] == [
        "turn one", "answer one"]
    assert _view(b, "session:s1")["session:title"] == "turn one"


def test_persona_and_user_projected(ws):
    ws_dir, conn = ws
    ev = _ev("2026-11-22T10:00:00Z", "user", "hi")
    ev.metadata["persona"] = "default"
    ev.metadata["user"] = "5712"
    ev.metadata["alias"] = "telegram:5712"
    project_session(conn, ws_dir, "s1", [ev], node="h")
    view = _view(conn, message_entity("s1", "2026-11-22T10:00:00Z", "user", "hi"))
    assert view["msg:persona"] == "default"
    # display alias is the portable handle; raw id only when no alias
    assert view["msg:user"] == "telegram:5712"


def test_host_local_paths_redacted_from_synced_text(ws):
    ws_dir, conn = ws
    tdir = ws_dir / "traces"
    tdir.mkdir()
    leak = f"log at {ws_dir}\\run\\x.txt"
    project_session(conn, ws_dir, "s1", [
        _ev("2026-11-22T10:00:00Z", "user", leak)], node="h",
        traces_dir=tdir)
    text = session_messages(conn, "s1")[0]["text"]
    assert str(ws_dir) not in text
    assert "~" in text
