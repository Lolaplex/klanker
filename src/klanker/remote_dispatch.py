"""session:host remote turn dispatch (klanker#145 R5).

Wired as ``agents_relay.http_adapter.remote_turn_dispatch`` by
``klanker serve``: when an incoming turn request names a session whose
``session:host`` binding points at a different paired device, the whole
request is forwarded to ``<hub>/v1/remote/dev-<host><path>`` under this
device's channel credential. The remote host executes inside the same
workspace; resulting msg:* datoms sync back over the op log, so remote
execution and sync stay one pipeline — no forked history.
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

log = logging.getLogger(__name__)


def _hub_rows() -> dict:
    from agents_workspace import Host

    p = Host.from_env().clients / "hubs.json"
    try:
        return dict(
            (json.loads(p.read_text(encoding="utf-8")) or {}).get("hubs")
            or {})
    except (OSError, json.JSONDecodeError):
        return {}


def _bound_host(session_id: str, ws_id: str) -> str:
    """session:host for the session in the given ws store ('' = free)."""
    from agents_store.db import connect
    from agents_workspace import Host

    from .session import session_view

    host = Host.from_env()
    try:
        ws = host.workspace(ws_id) if ws_id else host.select_workspace()
    except Exception:  # noqa: BLE001
        return ""
    conn = None
    try:
        conn = connect(ws.dir / "store.db", check_same_thread=False)
        return str(session_view(conn, session_id).get("host") or "")
    except Exception:  # noqa: BLE001
        return ""
    finally:
        if conn is not None:
            conn.close()


def remote_turn_dispatch(handler, path: str, body: dict) -> bool:
    """True when the turn was proxied to the session's bound host."""
    session = str(body.get("session") or "").strip()
    if not session:
        return False
    bound = _bound_host(session, str(body.get("workspace") or "").strip())
    if not bound:
        return False
    rows = _hub_rows()
    own = {str(r.get("device_id") or "") for r in rows.values()}
    if bound in own:
        return False  # bound to this device: execute locally
    for hub_id, row in rows.items():
        if _proxy(handler, row, hub_id, bound, path, body):
            return True
    log.warning("session %s bound to %s but no hub could proxy it",
                session, bound)
    return False


def _proxy(handler, row: dict, hub_id: str, device: str,
           path: str, body: dict) -> bool:
    from agents_relay.channel_client import hub_token

    token = hub_token(hub_id)
    if not token:
        return False
    url = (row["hub_url"].rstrip("/")
           + f"/v1/remote/dev-{device}{path}")
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": str(handler.headers.get("Accept")
                          or "application/json"),
            "Authorization": f"Bearer {token}",
            "X-Device-Id": str(row.get("device_id") or ""),
        },
        method="POST")
    try:
        resp = urllib.request.urlopen(req, timeout=600)
        status, ctype = resp.status, str(
            resp.headers.get("Content-Type") or "application/json")
    except urllib.error.HTTPError as exc:
        status, ctype = exc.code, "application/json"
        resp = exc
    except Exception as exc:  # noqa: BLE001
        log.info("remote dispatch via %s failed: %s", hub_id, exc)
        return False
    handler.send_response(status)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Cache-Control", "no-cache")
    handler.end_headers()
    try:
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            handler.wfile.write(chunk)
            handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    return True
