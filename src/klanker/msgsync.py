"""Session message domain: project trace message events into msg:* datoms.

The trace log stays the live write source; the store gets one
`msg:<session>:<seq>` entity per message so the op log can carry chat
history between hosts (klanker#136). Projection is ingest-based:
`origin_actor="proj:<session>"`, `origin_seq` = message ordinal —
`ux_tx_origin` makes every replay idempotent, crash-safe at any point.
hlc derives from the event ts so `ord` matches real message time.
"""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from agents_store.ingest import ingest

MSG_ATTRS = {
    "msg:session": ("text", "one"),
    "msg:role": ("text", "one"),
    "msg:text": ("text", "one"),
    "msg:ts": ("instant", "one"),
    "msg:deleted": ("bool", "one"),
    # session binding state (klanker#136) — slow fields only; the run
    # lock itself lives in hub leases, never in the log.
    "session:host": ("text", "one"),
    "session:branch": ("text", "one"),
    "session:repo": ("text", "one"),
    "session:wip_unpushed": ("bool", "one"),
}

PROJ_ROLES = ("user", "assistant", "system")


def ensure_domain(conn) -> None:
    for name, (vt, card) in MSG_ATTRS.items():
        conn.execute(
            "INSERT OR IGNORE INTO attr (name, value_type, cardinality, doc)"
            " VALUES (?, ?, ?, ?)",
            (name, vt, card, "session message domain (klanker msgsync)"))


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


def project_session(conn, ws_dir, session_id: str, events) -> dict:
    """Project message events of one session into msg:* datoms.

    `events` = TraceEvent objects (ts/type/metadata attrs). Returns
    {"projected", "skipped"}; safe to re-run — origin keys dedupe.
    """
    ensure_domain(conn)
    cursors = _load_cursors(ws_dir)
    key = f"proj:{session_id}"
    done = int(cursors.get(key) or 0)
    msgs = sorted(
        (e for e in events if getattr(e, "type", "") == "message"),
        key=lambda e: getattr(e, "ts", "") or "",
    )
    projected = skipped = 0
    for i, ev in enumerate(msgs):
        seq = i + 1
        if seq <= done:
            continue
        meta = getattr(ev, "metadata", None) or {}
        role = str(meta.get("role") or "user").lower()
        if role not in PROJ_ROLES:
            skipped += 1
            continue
        body = str(meta.get("content") or meta.get("prompt") or "")
        if not body.strip():
            skipped += 1
            continue
        ts = str(getattr(ev, "ts", "") or "")
        ms = _ms(ts)
        hlc = f"{ms:013d}.00000.proj" if ms else ""
        e = f"msg:{session_id}:{seq:06d}"
        # Content guard: entity may already exist from a synced envelope
        # (e.g. peer's trace files later reach this host). Origin keys
        # differ per host, so ux_tx_origin alone can't dedupe this path.
        if conn.execute(
                "SELECT 1 FROM datom WHERE e = ? AND a = 'msg:text' LIMIT 1",
                (e,)).fetchone():
            skipped += 1
            done = seq
            continue
        res = ingest(
            conn, f"proj:{session_id}", seq, hlc,
            [(e, "msg:session", session_id, True),
             (e, "msg:role", role, True),
             (e, "msg:text", body, True),
             (e, "msg:ts", ts, True)],
        )
        if res.applied:
            projected += 1
        else:
            skipped += 1
        done = seq
    cursors[key] = done
    _save_cursors(ws_dir, cursors)
    return {"projected": projected, "skipped": skipped}


def list_sessions(conn) -> list[str]:
    """Session ids that have projected messages."""
    ensure_domain(conn)
    return sorted(
        r[0] for r in conn.execute(
            "SELECT DISTINCT v FROM v_current WHERE a = 'msg:session'"))
