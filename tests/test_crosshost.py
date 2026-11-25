"""Cross-host session continuity: synced store.db projections on a peer.

Host A runs two turns and undoes the second; its ``store.db`` alone is
copied to Host B (fresh host dir, empty ``<ws>/traces``, empty
``personas/*/sessions``). Relay session surfaces, harness prompt
assembly, and msgsync readers must all show the session as if it lived
here — minus the deleted turn, which must never resurrect.
"""
import json
import shutil

import pytest

pytest.importorskip("agents_relay")
pytest.importorskip("agents_traces")
pytest.importorskip("runner")

from agents_store.db import connect  # noqa: E402


def _append(path, line: dict):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(line) + "\n")


def _msg(ts, role, content, session="s1"):
    return {"ts": ts, "session": session, "type": "message",
            "metadata": {"role": role, "content": content,
                         "channel": "http", "user": "me"}}


def test_synced_store_carries_session_to_peer(tmp_path, monkeypatch):
    from agents_workspace import Host
    from klanker import msgsync

    # ---- Host A: workspace, traces, two turns over two days ----
    host_a = tmp_path / "hostA"
    monkeypatch.setenv("AGENTS_HOST_DIR", str(host_a))
    monkeypatch.setenv("AGENTS_WORKSPACE", "w1")
    ws_a = Host.from_env().create("w1")
    ws_a.traces.mkdir(parents=True, exist_ok=True)
    _append(ws_a.traces / "2026-11-20.jsonl",
            _msg("2026-11-20T09:00:00Z", "user", "turn one prompt"))
    _append(ws_a.traces / "2026-11-20.jsonl",
            _msg("2026-11-20T09:00:05Z", "assistant", "answer one"))
    _append(ws_a.traces / "2026-11-22.jsonl",
            _msg("2026-11-22T10:01:00Z", "user", "turn two prompt"))
    _append(ws_a.traces / "2026-11-22.jsonl",
            _msg("2026-11-22T10:01:05Z", "assistant", "answer two"))

    conn_a = connect(ws_a.store_db)
    stats = msgsync.project_traces(conn_a, ws_a.dir, node="hostA")
    assert stats["projected"] == 4

    # ---- /undo turn two through the real harness op (frame + mark) ----
    from runner import session_ops

    assert session_ops.undo_last_turn("s1")["ok"]
    # the harness hook projected the frame already; the tick path replays
    # it idempotently (skipped, not double-marked)
    msgs = msgsync.session_messages(conn_a, "s1")
    assert [m["text"] for m in msgs] == ["turn one prompt", "answer one"]
    conn_a.close()

    # ---- Host B: fresh host dir + empty traces/personas + the db ----
    host_b = tmp_path / "hostB"
    monkeypatch.setenv("AGENTS_HOST_DIR", str(host_b))
    ws_b = Host.from_env().create("w1")
    ws_b.traces.mkdir(parents=True, exist_ok=True)
    shutil.copy(ws_a.dir / "store.db", ws_b.dir / "store.db")
    for suffix in ("-wal", "-shm"):
        extra = ws_a.dir / f"store.db{suffix}"
        if extra.exists():
            shutil.copy(extra, ws_b.dir / f"store.db{suffix}")

    # relay list: synced-only session survives empty_grace_sec=0 and a
    # title scan over an empty <ws>/traces
    from agents_relay.workspaces import get_session, list_sessions

    rows = list_sessions(ws_b, persona="default", empty_grace_sec=0)
    assert [r["id"] for r in rows] == ["s1"]
    assert rows[0]["title"] == "turn one prompt"
    assert rows[0]["last_active"] == "2026-11-20T09:00:05Z"
    assert rows[0]["host"] == "hostA"

    # relay detail: union record + only the live turn
    rec = get_session(ws_b, "default", "s1")
    assert rec is not None
    assert rec["title"] == "turn one prompt"
    from agents_relay.storeproj import union_events

    events = union_events(ws_b, "s1", [])
    bodies = [e["metadata"]["content"] for e in events]
    assert bodies == ["turn one prompt", "answer one"]

    # prompt assembly on host B feeds the live turn to the LLM payload
    from agents_traces.assemble import assemble_messages
    from agents_traces.store import TraceStore

    out = assemble_messages("s1", store=TraceStore(ws_b.traces))
    texts = [m["content"] for m in out]
    assert any("turn one prompt" in t for t in texts)
    assert any("answer one" in t for t in texts)
    assert not any("turn two" in t for t in texts)

    # msgsync reader on the peer agrees: live msgs only, ordered
    conn_b = connect(ws_b.store_db)
    msgs_b = msgsync.session_messages(conn_b, "s1")
    assert [m["text"] for m in msgs_b] == ["turn one prompt", "answer one"]
    assert msgsync.list_sessions(conn_b) == ["s1"]
    conn_b.close()


def test_relay_title_uses_oldest_day_first_user_msg(tmp_path, monkeypatch):
    """Multi-day session: the sidebar title is the OLDEST trace day's
    first user message, not the newest day's."""
    from agents_workspace import Host
    from agents_relay.workspaces import list_sessions

    host = tmp_path / "hostC"
    monkeypatch.setenv("AGENTS_HOST_DIR", str(host))
    ws = Host.from_env().create("w1")
    ws.traces.mkdir(parents=True, exist_ok=True)
    _append(ws.traces / "2026-11-20.jsonl",
            _msg("2026-11-20T09:00:00Z", "user", "day one opener"))
    _append(ws.traces / "2026-11-20.jsonl",
            _msg("2026-11-20T09:00:05Z", "assistant", "reply"))
    _append(ws.traces / "2026-11-22.jsonl",
            _msg("2026-11-22T10:00:00Z", "user", "day three opener"))
    sdir = ws.personas / "default" / "sessions"
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / "s1.json").write_text(json.dumps(
        {"id": "s1", "user": "u_x", "start_date": "2026-11-20"}) + "\n",
        encoding="utf-8")
    rows = list_sessions(ws, persona="default")
    assert len(rows) == 1
    assert rows[0]["title"] == "day one opener"
