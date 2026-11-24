"""Session message domain: project trace message events into msg:* datoms.

The trace log stays the live write source; the store gets one msg entity
per message so the op log can carry chat history between hosts
(klanker#136). A session may run on several hosts over its life (host
switch between prompts), so every identity here is host-safe:

- entity  ``msg:<session>:<key>`` -- ``key`` is a content hash of the
  event (ts, role, text). Never a local ordinal: two hosts projecting
  different parts of one session can no longer collide on
  ``msg:<sid>:000001``; the same event projected twice (e.g. trace files
  copied between hosts) maps to the same entity and is skipped.
- origin  ``proj@<node>:<session>`` with a per-actor ``origin_seq`` that
  continues from the store's high-water mark, so ``ux_tx_origin`` never
  dedupes one host's message against another host's.
- ``msg:host`` records which host projected the message; ``msg:ts`` is
  the ordering key across hosts (hlc derives from the event ts).

Projection is incremental: ``project_traces`` keeps a byte offset per
daily trace file in ``<ws>/msg_cursors.json`` and only parses lines
appended since the last tick -- no full trace rescan.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime
from pathlib import Path

from agents_store.ingest import ingest

MSG_ATTRS = {
    "msg:session": ("text", "one"),
    "msg:role": ("text", "one"),
    "msg:text": ("text", "one"),
    "msg:ts": ("instant", "one"),
    "msg:host": ("text", "one"),
    "msg:deleted": ("bool", "one"),
    # session binding state (klanker#136) -- slow fields only; the run
    # lock itself lives in hub leases, never in the log.
    "session:host": ("text", "one"),
    "session:branch": ("text", "one"),
    "session:repo": ("text", "one"),
    "session:wip_unpushed": ("bool", "one"),
}

PROJ_ROLES = ("user", "assistant", "system")

# Actor kinds whose ingest-based txs are minted locally (projection,
# file import, session binding). ``local_origin_prefixes(node)`` turns
# them into exact per-host prefixes for ops_since(local_origins=...), so
# a peer's projections relayed through the hub are never echoed back.
LOCAL_ACTOR_KINDS = ("proj", "import", "bind")


def actor(kind: str, node: str, rest: str) -> str:
    return f"{kind}@{node}:{rest}"


def local_origin_prefixes(node: str) -> tuple[str, ...]:
    return tuple(f"{k}@{node}:" for k in LOCAL_ACTOR_KINDS)


def local_node_id() -> str:
    """Stable host identity for locally minted actors."""
    try:
        from agents_workspace import Host

        return str(Host.from_env().host_id())
    except Exception:  # noqa: BLE001 - no host dir (tests, bare CLI)
        import socket

        return f"host_{socket.gethostname()}"


def next_seq(conn, origin_actor: str) -> int:
    """Next origin_seq for ``origin_actor`` -- continues past anything the
    store already holds, so a lost cursor file can never reuse a seq."""
    row = conn.execute(
        "SELECT MAX(origin_seq) FROM tx WHERE origin_actor = ?",
        (origin_actor,)).fetchone()
    return int(row[0] or 0) + 1 if row else 1


def ensure_domain(conn) -> None:
    """Register the full syncable schema (msg + session + migrate domains).

    Delegates to ``store_domains.ensure_domains`` so every host that can
    ingest also knows ``persona:*``/``cfg:*``/``mem:*`` — remote migrate
    datoms would otherwise die as ``unknown_attr`` refusals.
    """
    from .store_domains import ensure_domains

    ensure_domains(conn)


def _cursor_path(ws_dir: str | Path) -> Path:
    return Path(ws_dir) / "msg_cursors.json"


def _load_cursors(ws_dir) -> dict:
    p = _cursor_path(ws_dir)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_cursors(ws_dir, data: dict) -> None:
    p = _cursor_path(ws_dir)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, indent=1, sort_keys=True) + "\n")
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _ms(ts: str) -> int:
    try:
        return int(
            datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, OverflowError):
        return 0


def message_key(ts: str, role: str, body: str) -> str:
    h = hashlib.sha256(f"{ts}\x1f{role}\x1f{body}".encode("utf-8"))
    return h.hexdigest()[:20]


def message_entity(session_id: str, ts: str, role: str, body: str) -> str:
    return f"msg:{session_id}:{message_key(ts, role, body)}"


def _body(ev, traces_dir) -> str:
    meta = getattr(ev, "metadata", None) or {}
    body = meta.get("content")
    if body is None:
        body = meta.get("prompt")
    body = str(body or "")
    if traces_dir is not None and meta.get("truncated") and meta.get("sha256"):
        try:  # full text of a spilled (> inline cap) message
            from agents_traces.content import load_retained

            body = str(load_retained(Path(traces_dir), body, meta, ""))
        except Exception:  # noqa: BLE001 - inline prefix still beats nothing
            pass
    return body


def project_event(conn, node: str, ev, *, traces_dir=None) -> str:
    """Project one trace event. Returns "projected" | "skipped"."""
    if getattr(ev, "type", "") != "message":
        return "skipped"
    session_id = str(getattr(ev, "session", "") or "")
    meta = getattr(ev, "metadata", None) or {}
    role = str(meta.get("role") or "").lower()
    if not session_id or role not in PROJ_ROLES:
        return "skipped"  # never guess a role
    body = _body(ev, traces_dir)
    if not body.strip():
        return "skipped"
    ts = str(getattr(ev, "ts", "") or "")
    e = message_entity(session_id, ts, role, body)
    # Same event already present (own earlier projection, or a peer's
    # synced projection of the same trace line): nothing to do.
    if conn.execute(
            "SELECT 1 FROM datom WHERE e = ? AND a = 'msg:text' LIMIT 1",
            (e,)).fetchone():
        return "skipped"
    ms = _ms(ts)
    hlc = f"{ms:013d}.00000.proj" if ms else ""
    origin = actor("proj", node, session_id)
    res = ingest(
        conn, origin, next_seq(conn, origin), hlc,
        [(e, "msg:session", session_id, True),
         (e, "msg:role", role, True),
         (e, "msg:text", body, True),
         (e, "msg:ts", ts, True),
         (e, "msg:host", node, True)],
    )
    return "projected" if res.applied else "skipped"


def project_session(conn, ws_dir, session_id: str, events, *,
                    node: str | None = None, traces_dir=None) -> dict:
    """Project the message events of one session (explicit event list).

    Safe to re-run: entities are content-addressed, replays skip.
    """
    ensure_domain(conn)
    node = node or local_node_id()
    stats = {"projected": 0, "skipped": 0}
    msgs = sorted(
        (e for e in events if getattr(e, "type", "") == "message"
         and str(getattr(e, "session", session_id) or session_id) == session_id),
        key=lambda e: getattr(e, "ts", "") or "")
    for ev in msgs:
        if not getattr(ev, "session", None):
            try:
                ev.session = session_id
            except AttributeError:
                pass
        stats[project_event(conn, node, ev, traces_dir=traces_dir)] += 1
    return stats


def project_traces(conn, ws_dir, traces_dir=None, *,
                   node: str | None = None) -> dict:
    """Incrementally project every new message line of ``<ws>/traces``.

    Keeps ``{"files": {"<day>.jsonl": byte_offset}}`` in
    ``<ws>/msg_cursors.json``; only complete lines appended since the
    last call are parsed. A file that shrank (rewrite/prune) restarts at
    0 -- content-addressed entities make the replay a no-op.
    """
    from agents_traces.models import TraceEvent

    ensure_domain(conn)
    node = node or local_node_id()
    ws_dir = Path(ws_dir)
    tdir = Path(traces_dir) if traces_dir else ws_dir / "traces"
    stats = {"projected": 0, "skipped": 0, "files": 0}
    if not tdir.is_dir():
        return stats
    cursors = _load_cursors(ws_dir)
    offsets = cursors.get("files")
    if not isinstance(offsets, dict):
        offsets = {}
    changed = False
    for path in sorted(tdir.glob("*.jsonl")):
        try:
            size = path.stat().st_size
        except OSError:
            continue
        off = int(offsets.get(path.name) or 0)
        if size < off:
            off = 0
        if size == off:
            continue
        with open(path, "rb") as f:
            f.seek(off)
            chunk = f.read(size - off)
        end = chunk.rfind(b"\n")
        if end < 0:
            continue  # partial line still being written
        stats["files"] += 1
        for raw in chunk[: end + 1].splitlines():
            if b'"message"' not in raw:
                continue  # cheap pre-filter: not a message event
            ev = TraceEvent.from_json(raw.decode("utf-8", errors="replace"))
            if ev is None:
                continue
            stats[project_event(conn, node, ev, traces_dir=tdir)] += 1
        offsets[path.name] = off + end + 1
        changed = True
    if changed:
        cursors["files"] = offsets
        _save_cursors(ws_dir, cursors)
    return stats


def list_sessions(conn) -> list[str]:
    """Session ids that have projected messages."""
    ensure_domain(conn)
    return sorted(
        r[0] for r in conn.execute(
            "SELECT DISTINCT v FROM v_current WHERE a = 'msg:session'"))


def session_messages(conn, session_id: str) -> list[dict]:
    """Merged cross-host history of one session, ordered by event ts."""
    ensure_domain(conn)
    rows: dict[str, dict] = {}
    for e, a, v in conn.execute(
            "SELECT e, a, v FROM v_current WHERE e IN ("
            " SELECT e FROM v_current WHERE a = 'msg:session' AND v = ?)",
            (session_id,)):
        rows.setdefault(e, {"e": e})[a.split(":", 1)[1]] = v
    return sorted(rows.values(), key=lambda r: (r.get("ts") or "", r["e"]))
