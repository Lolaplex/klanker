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
import re
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
    "msg:persona": ("text", "one"),
    "msg:user": ("text", "one"),
    "msg:frame_id": ("text", "one"),
    "msg:deleted": ("bool", "one"),
    # session binding state (klanker#136) -- slow fields only; the run
    # lock itself lives in hub leases, never in the log.
    "session:host": ("text", "one"),
    "session:branch": ("text", "one"),
    "session:repo": ("text", "one"),
    "session:wip_unpushed": ("bool", "one"),
    # projection-maintained summary: title = earliest live user message,
    # last_active = newest live message ts (maintained by _refresh_session).
    "session:title": ("text", "one"),
    "session:last_active": ("instant", "one"),
    # coverage frames (/undo /retry /compress): a frame entity marks every
    # msg in its summarized_from span deleted and retires covered frames,
    # so undone/superseded turns never resurrect on a synced peer.
    "frame:session": ("text", "one"),
    "frame:kind": ("text", "one"),
    "frame:first_ts": ("instant", "one"),
    "frame:last_ts": ("instant", "one"),
    "frame:ts": ("instant", "one"),
    "frame:host": ("text", "one"),
    "frame:retired": ("bool", "one"),
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


def _proj_hlc(ts: str) -> str:
    """Deterministic ord for a projected datom: the event's own clock."""
    ms = _ms(ts)
    return f"{ms:013d}.00000.proj" if ms else "0000000000000.00000.proj"


def _node_part(node: str) -> str:
    try:
        from agents_store.hlc import normalize_node_id

        return normalize_node_id(node)
    except Exception:  # noqa: BLE001 - older agents-store without hlc module
        import re

        return re.sub(r"[^A-Za-z0-9_-]", "_", node or "proj")[:32] or "proj"


def _fresh_ord(conn, node: str) -> str:
    """Ord strictly above every HLC datom already in the store.

    Deletion marks and session:* maintenance are rewrites relative to the
    projected event stream, so they need a live clock (not a ts-derived
    ord) to win v_current's max-ord rule on every host, replay included.
    Seeded over ``HLC_GLOB`` only — a non-HLC ord shape must never
    inflate the seed (klanker#155).
    """
    import time

    try:
        from agents_store.hlc import HLC_GLOB
    except ImportError:
        HLC_GLOB = "[0-9]*.[0-9]*.*"
    ms = int(time.time() * 1000)
    row = conn.execute(
        "SELECT MAX(ord) FROM datom WHERE ord GLOB ?",
        (HLC_GLOB,)).fetchone()
    head = str(row[0]).split(".", 1)[0] if row and row[0] else ""
    if head.isdigit():
        ms = max(ms, int(head) + 1)
    return f"{ms:013d}.00000.{_node_part(node)}"


def _redact_local_paths(text: str, ws_dir) -> str:
    """Host-local absolute paths mean nothing on a peer -- strip them from
    the synced body before it lands in store.db. Windows compares paths
    case-insensitively, so the redaction must too (klanker#155)."""
    roots = {str(Path.home())}
    for raw in (os.environ.get("AGENTS_HOST_DIR") or "",
                str(ws_dir) if ws_dir else ""):
        if raw:
            roots.add(raw)
    flags = re.IGNORECASE if os.name == "nt" else 0
    for root in sorted((r for r in roots if len(r) > 3), key=len,
                       reverse=True):
        text = re.sub(re.escape(root), "~", text, flags=flags)
        if os.sep != "/":
            text = re.sub(re.escape(root.replace(os.sep, "/")), "~",
                          text, flags=flags)
    return text


def message_key(ts: str, role: str, body: str) -> str:
    h = hashlib.sha256(f"{ts}\x1f{role}\x1f{body}".encode("utf-8"))
    return h.hexdigest()[:20]


def message_entity(session_id: str, ts: str, role: str, body: str) -> str:
    return f"msg:{session_id}:{message_key(ts, role, body)}"


def _frame_key(ev, first_ts: str, last_ts: str, kind: str,
               content: str) -> str:
    raw = "\x1f".join(
        [str(getattr(ev, "ts", "") or ""), kind, first_ts, last_ts, content])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def _frame_bounds(meta: dict) -> tuple[str, str]:
    span = meta.get("summarized_from") or {}
    if isinstance(span, dict):
        return (str(span.get("first_ts") or ""),
                str(span.get("last_ts") or ""))
    return "", ""


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


def _session_entities(conn, session_id: str, attr: str) -> list[str]:
    return [r[0] for r in conn.execute(
        "SELECT e FROM v_current WHERE a = ? AND v = ?",
        (attr, session_id))]


def _retired_frames(conn, session_id: str) -> set[str]:
    return {r[0] for r in conn.execute(
        "SELECT r.e FROM v_current r JOIN v_current s ON s.e = r.e"
        " WHERE r.a = 'frame:retired' AND r.v = 'true'"
        " AND s.a = 'frame:session' AND s.v = ?", (session_id,))}


def _covering_frame(conn, session_id: str, ts: str) -> str:
    """Unretired ``frame:*`` entity whose ``first_ts..last_ts`` span
    covers ``ts`` — a msg projected after its covering frame must arrive
    already deleted, or replay order resurrects covered turns
    (klanker#155)."""
    retired = _retired_frames(conn, session_id)
    for fe in _session_entities(conn, session_id, "frame:session"):
        if fe in retired:
            continue
        bounds = {a: v for a, v in conn.execute(
            "SELECT a, v FROM v_current WHERE e = ?"
            " AND a IN ('frame:first_ts','frame:last_ts')", (fe,))}
        first, last = (str(bounds.get("frame:first_ts") or ""),
                       str(bounds.get("frame:last_ts") or ""))
        if first and last and first <= ts <= last:
            return fe
    return ""


def _entity_ord(conn, entities: list[str]) -> dict[str, str]:
    if not entities:
        return {}
    marks = ",".join("?" for _ in entities)
    return {e: o for e, o in conn.execute(
        f"SELECT e, MAX(ord) FROM datom WHERE e IN ({marks}) GROUP BY e",
        entities)}


def _live_msgs(conn, session_id: str) -> list[dict]:
    """msg:* entities of a session minus deleted/superseded ones."""
    rows: dict[str, dict] = {}
    for e, a, v in conn.execute(
            "SELECT e, a, v FROM v_current WHERE e IN ("
            " SELECT e FROM v_current WHERE a = 'msg:session' AND v = ?)",
            (session_id,)):
        rows.setdefault(e, {"e": e})[a.split(":", 1)[1]] = v
    retired = _retired_frames(conn, session_id)
    live = [r for r in rows.values()
            if r.get("deleted") != "true"
            and str(r.get("frame_id") or "") not in retired]
    ords = _entity_ord(conn, [r["e"] for r in live])
    for r in live:
        r["ord"] = ords.get(r["e"], "")
    return sorted(live, key=lambda r: (r.get("ts") or "",
                                       r.get("ord") or "", r["e"]))


def _refresh_session(conn, session_id: str, node: str) -> None:
    """Maintain session:title / session:last_active from live msg:* rows.

    Card-one LWW keeps the newest ord, so a change rewrites both attrs in
    one tx at a fresh ord -- retracts stale values, asserts the wanted
    ones. No-op when the stored view already matches; converges under
    cross-host op replay because every host recomputes the same wanted.
    """
    live = _live_msgs(conn, session_id)
    e = f"session:{session_id}"
    title = next(
        (str(r.get("text") or "")[:160] for r in live
         if r.get("role") == "user" and str(r.get("text") or "").strip()),
        "")
    last_active = live[-1].get("ts") if live else ""
    want = {"session:title": title or None,
            "session:last_active": str(last_active or "") or None}
    cur = {a: v for a, v in conn.execute(
        "SELECT a, v FROM v_current WHERE e = ?"
        " AND a IN ('session:title', 'session:last_active')", (e,))}
    datoms: list[tuple] = []
    for a, wanted in want.items():
        have = cur.get(a)
        if have == wanted or (have is None and wanted is None):
            continue
        if have is not None:
            datoms.append((e, a, have, False))
        if wanted is not None:
            datoms.append((e, a, wanted, True))
    if not datoms:
        return
    origin = actor("proj", node, session_id)
    ingest(conn, origin, next_seq(conn, origin), _fresh_ord(conn, node),
           datoms)


def project_frame(conn, node: str, ev, *, traces_dir=None) -> str:
    """Project one trace ``frame`` event (coverage tombstone + summary).

    The frame entity itself is content-addressed like msg:*; every msg in
    its ``summarized_from`` span is marked ``msg:deleted`` + ``msg:frame_id``
    at the frame's ord, and covered frames are retired. A non-empty
    ``content`` (compaction summary) lands as a live system msg whose
    ``msg:frame_id`` retires it with the frame.
    """
    session_id = str(getattr(ev, "session", "") or "")
    meta = getattr(ev, "metadata", None) or {}
    first_ts, last_ts = _frame_bounds(meta)
    if not session_id or not first_ts or not last_ts:
        return "skipped"
    kind = str(meta.get("kind") or "")
    content = _redact_local_paths(
        str(meta.get("content") or ""),
        Path(traces_dir).parent if traces_dir else None)
    ts = str(getattr(ev, "ts", "") or "")
    fe = f"frame:{session_id}:{_frame_key(ev, first_ts, last_ts, kind, content)}"
    if conn.execute(
            "SELECT 1 FROM datom WHERE e = ? AND a = 'frame:session' LIMIT 1",
            (fe,)).fetchone():
        return "skipped"  # same frame already projected
    hlc = _proj_hlc(ts)
    origin = actor("proj", node, session_id)
    seq = next_seq(conn, origin)
    datoms = [
        (fe, "frame:session", session_id, True),
        (fe, "frame:kind", kind, True),
        (fe, "frame:first_ts", first_ts, True),
        (fe, "frame:last_ts", last_ts, True),
        (fe, "frame:ts", ts, True),
        (fe, "frame:host", node, True),
    ]
    covered = _session_entities(conn, session_id, "msg:session")
    for me in covered:
        mts = conn.execute(
            "SELECT v FROM v_current WHERE e = ? AND a = 'msg:ts'",
            (me,)).fetchone()
        if mts and str(first_ts) <= str(mts[0]) <= str(last_ts):
            datoms.append((me, "msg:deleted", "true", True))
            datoms.append((me, "msg:frame_id", fe, True))
    for other in _session_entities(conn, session_id, "frame:session"):
        if other == fe:
            continue
        ots = conn.execute(
            "SELECT v FROM v_current WHERE e = ? AND a = 'frame:ts'",
            (other,)).fetchone()
        if ots and str(first_ts) <= str(ots[0]) <= str(last_ts):
            datoms.append((other, "frame:retired", "true", True))
    if content.strip():
        se = message_entity(session_id, ts, "system", content)
        datoms.extend([
            (se, "msg:session", session_id, True),
            (se, "msg:role", "system", True),
            (se, "msg:text", content, True),
            (se, "msg:ts", ts, True),
            (se, "msg:host", node, True),
            (se, "msg:frame_id", fe, True),
        ])
    res = ingest(conn, origin, seq, hlc, datoms)
    if res.applied:
        _refresh_session(conn, session_id, node)
    return "projected" if res.applied else "skipped"


def project_event(conn, node: str, ev, *, traces_dir=None) -> str:
    """Project one trace event. Returns "projected" | "skipped"."""
    etype = getattr(ev, "type", "")
    if etype == "frame":
        return project_frame(conn, node, ev, traces_dir=traces_dir)
    if etype != "message":
        return "skipped"
    session_id = str(getattr(ev, "session", "") or "")
    meta = getattr(ev, "metadata", None) or {}
    role = str(meta.get("role") or "").lower()
    if not session_id or role not in PROJ_ROLES:
        return "skipped"  # never guess a role
    body = _body(ev, traces_dir)
    if not body.strip():
        return "skipped"
    body = _redact_local_paths(
        body, Path(traces_dir).parent if traces_dir else None)
    ts = str(getattr(ev, "ts", "") or "")
    e = message_entity(session_id, ts, role, body)
    # Same event already present (own earlier projection, or a peer's
    # synced projection of the same trace line): nothing to do.
    if conn.execute(
            "SELECT 1 FROM datom WHERE e = ? AND a = 'msg:text' LIMIT 1",
            (e,)).fetchone():
        return "skipped"
    origin = actor("proj", node, session_id)
    datoms = [(e, "msg:session", session_id, True),
              (e, "msg:role", role, True),
              (e, "msg:text", body, True),
              (e, "msg:ts", ts, True),
              (e, "msg:host", node, True)]
    persona = str(meta.get("persona") or "")
    if persona:
        datoms.append((e, "msg:persona", persona, True))
    # display alias ("telegram:5712") is the portable handle; raw user id
    # is the fallback when no alias was recorded
    user = str(meta.get("alias") or meta.get("user") or "")
    if user:
        datoms.append((e, "msg:user", user, True))
    cover = _covering_frame(conn, session_id, ts)
    if cover:
        # dead on arrival: the frame covering this span already landed
        datoms.append((e, "msg:deleted", "true", True))
        datoms.append((e, "msg:frame_id", cover, True))
    res = ingest(conn, origin, next_seq(conn, origin), _proj_hlc(ts), datoms)
    return "projected" if res.applied else "skipped"


def project_session(conn, ws_dir, session_id: str, events, *,
                    node: str | None = None, traces_dir=None) -> dict:
    """Project the message/frame events of one session (explicit list).

    Safe to re-run: entities are content-addressed, replays skip.
    """
    ensure_domain(conn)
    node = node or local_node_id()
    stats = {"projected": 0, "skipped": 0}
    evs = sorted(
        (e for e in events
         if getattr(e, "type", "") in ("message", "frame")
         and str(getattr(e, "session", session_id) or session_id) == session_id),
        key=lambda e: getattr(e, "ts", "") or "")
    for ev in evs:
        if not getattr(ev, "session", None):
            try:
                ev.session = session_id
            except AttributeError:
                pass
        stats[project_event(conn, node, ev, traces_dir=traces_dir)] += 1
    _refresh_session(conn, session_id, node)
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
    touched: set[str] = set()
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
            if b'"message"' not in raw and b'"frame"' not in raw:
                continue  # cheap pre-filter: only message/frame events
            ev = TraceEvent.from_json(raw.decode("utf-8", errors="replace"))
            if ev is None:
                continue
            stats[project_event(conn, node, ev, traces_dir=tdir)] += 1
            sid = str(getattr(ev, "session", "") or "")
            if sid:
                touched.add(sid)
        offsets[path.name] = off + end + 1
        changed = True
    for sid in touched:
        _refresh_session(conn, sid, node)
    if changed:
        cursors["files"] = offsets
        _save_cursors(ws_dir, cursors)
    return stats


def list_sessions(conn) -> list[str]:
    """Session ids that still hold at least one live projected message."""
    ensure_domain(conn)
    sids = [r[0] for r in conn.execute(
        "SELECT DISTINCT v FROM v_current WHERE a = 'msg:session'")]
    return sorted(s for s in sids if _live_msgs(conn, s))


def session_messages(conn, session_id: str) -> list[dict]:
    """Merged cross-host history of one session.

    Live messages only -- ``msg:deleted`` and retired-frame supersession
    (``msg:frame_id`` -> retired frame) drop covered turns -- ordered by
    ``(ts, ord, entity)`` so concurrent-host interleaves are stable.
    """
    ensure_domain(conn)
    return _live_msgs(conn, session_id)


def session_summary(conn, session_id: str) -> dict:
    """session:* + first-live-persona/user view used by session listings."""
    ensure_domain(conn)
    e = f"session:{session_id}"
    out = {"id": session_id}
    for a, v in conn.execute(
            "SELECT a, v FROM v_current WHERE e = ? AND a LIKE 'session:%'",
            (e,)):
        out[a.split(":", 1)[1]] = v
    for r in _live_msgs(conn, session_id):
        if r.get("persona") or r.get("user"):
            out.setdefault("persona", str(r.get("persona") or ""))
            out.setdefault("user", str(r.get("user") or ""))
            break
    if not out.get("title") or not out.get("last_active"):
        live = _live_msgs(conn, session_id)
        if live:
            out.setdefault("last_active", str(live[-1].get("ts") or ""))
            if not out.get("title"):
                out["title"] = next(
                    (str(r.get("text") or "")[:160] for r in live
                     if r.get("role") == "user"
                     and str(r.get("text") or "").strip()), "")
    return out
