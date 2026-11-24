"""Live hub-link + session host management hooks (agents-relay#43).

Wired by ``klanker serve`` into ``agents_relay.http_adapter``:

- ``hub_links()``: public hubs.json rows + live connected state —
  never tokens.
- ``hub_connect(body)``: redeem an invite code/URL against a hub,
  persist the hubs.json row + host-vault token, and let the running
  SyncRuntime attach a ChannelClient on its next tick — no serve
  restart.
- ``hub_disconnect(hub_id)``: stop the live client + retire workers,
  drop the row + vault secret.
- ``session_host_switch(ws, sid, host, force)``: the HTTP entry into
  ``session.switch_host`` — checkpoint -> rebind -> cleanup.
"""
from __future__ import annotations

import json
import logging
import re
import urllib.parse

log = logging.getLogger(__name__)

_INVITE_RE = re.compile(r"^#?pair=([A-Za-z0-9_-]{3,64})$")
_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{3,64}$")


def _runtime():
    from .wssync import _runtime as _rt

    return _rt()


def _hubs_path():
    from agents_workspace import Host

    return Host.from_env().clients / "hubs.json"


def _hub_rows() -> dict:
    try:
        return dict(
            (json.loads(_hubs_path().read_text(encoding="utf-8")) or {})
            .get("hubs") or {})
    except (OSError, json.JSONDecodeError):
        return {}


def hub_links() -> dict:
    """GET /v1/hub/links — public row metadata + live attach state."""
    rt = _runtime()
    links = []
    for hub_id, row in sorted(_hub_rows().items()):
        links.append({
            "hub_id": hub_id,
            "hub_url": str(row.get("hub_url") or ""),
            "device_id": str(row.get("device_id") or ""),
            "label": str(row.get("label") or ""),
            "connected_at": int(row.get("connected_at") or 0),
            "connected": bool(
                rt is not None and rt.client_connected(hub_id)),
        })
    return {"links": links}


def _parse_connect(body: dict) -> tuple[str, str]:
    """(hub_url, code) from a pair URL or bare url+code fields."""
    url = str(body.get("url") or "").strip().rstrip("/")
    code = str(body.get("code") or body.get("token") or "").strip()
    frag = urllib.parse.urlparse(url).fragment
    if frag.startswith("pair="):
        code = frag[5:]
        url = url.split("#", 1)[0].rstrip("/")
    if not url or not url.startswith(("http://", "https://")):
        return "", ""
    if not _CODE_RE.match(code):
        return url, ""
    return url, code


def hub_connect(body: dict) -> dict:
    """POST /v1/hub/connect — redeem + persist + live-attach."""
    from agents_relay.channel_client import connect_hub

    url, code = _parse_connect(body)
    if not url or not code:
        return {"ok": False, "error": "need url + pair code",
                "status": 400}
    label = str(body.get("label") or "")
    try:
        row = connect_hub(url, code, label=label)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False,
                "error": f"redeem failed: {exc}", "status": 502}
    rt = _runtime()
    if rt is not None:
        rt._attach_new_hubs()  # immediate attach, not next-tick
    return {"ok": True, "hub_id": row.get("hub_id"),
            "device_id": row.get("device_id"),
            "connected": bool(
                rt is not None and rt.client_connected(
                    str(row.get("hub_id") or "")))}


def hub_disconnect(hub_id: str) -> dict:
    """DELETE /v1/hub/links/<id> — retire client, row, and token."""
    from agents_relay.channel_client import disconnect_hub

    rt = _runtime()
    if rt is not None:
        rt.detach_client(hub_id)
    if not disconnect_hub(hub_id):
        return {"ok": False, "error": "unknown hub", "status": 404}
    return {"ok": True, "hub_id": hub_id}


def session_host_switch(ws_id: str, session_id: str, new_host: str,
                        *, force: bool = False) -> dict:
    """POST /v1/workspaces/<ws>/sessions/<sid>/host."""
    from agents_store.db import connect
    from agents_workspace import Host

    from .remote_dispatch import _host_path_for
    from .session import (remove_worktree, session_view,
                          switch_host)

    host = Host.from_env()
    try:
        if not host.workspace_exists(ws_id):
            return {"error": "unknown workspace", "status": 404}
        ws = host.workspace(ws_id)
    except Exception:  # noqa: BLE001
        return {"error": "unknown workspace", "status": 404}
    conn = None
    try:
        conn = connect(ws.dir / "store.db", check_same_thread=False)
        view = session_view(conn, session_id)
        old = str(view.get("host") or "")
        if old == new_host:
            return {"session": session_id, "host": new_host,
                    "unchanged": True}
        slug = str(view.get("repo") or "").split(":", 1)[0]
        checkout = _host_path_for(ws, slug) if slug else None
        res = switch_host(
            conn, session_id, new_host, repo=checkout,
            old_host=old, ws_id=ws.id, force=force)
        if not res.get("bound"):
            return {"error": res.get("error"),
                    "status": int(res.get("status") or 409),
                    "holder": res.get("holder", "")}
        if checkout is not None and res.get("checkpoint") \
                and not res["checkpoint"].get("unpushed"):
            remove_worktree(checkout, session_id)
        return {"session": session_id, "host": new_host,
                "checkpoint": res.get("checkpoint")}
    finally:
        if conn is not None:
            conn.close()


def ws_policy_changed(ws_id: str) -> None:
    """PATCH /v1/workspaces policy write -> reconcile immediately,
    not at the next tick (agents-relay#43)."""
    rt = _runtime()
    if rt is None:
        return
    try:
        rt._reconcile_shares()
    except Exception as exc:  # noqa: BLE001
        log.warning("share reconcile after policy change failed: %s",
                    exc)
