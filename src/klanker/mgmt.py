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
        status = (rt.client_status(hub_id) if rt is not None
                  else {"connected": False, "revoked": False,
                        "last_error": ""})
        links.append({
            "hub_id": hub_id,
            "hub_url": str(row.get("hub_url") or ""),
            "device_id": str(row.get("device_id") or ""),
            "label": str(row.get("label") or ""),
            "connected_at": int(row.get("connected_at") or 0),
            "connected": bool(status.get("connected")),
            "revoked": bool(status.get("revoked")),
            "last_error": str(status.get("last_error") or ""),
        })
    return {"links": links}


def _parse_connect(body: dict) -> tuple[str, str]:
    """(hub_url, code) from a pair URL or bare url+code fields.

    Fragment shapes minted by pairing.py: ``#pair=<code>``,
    ``#kind=remote&pair=<code>`` and ``#kind=ws&ws=<id>&pair=<code>``
    (ws invite — the ws id rides inside the token, the code is what we
    redeem)."""
    url = str(body.get("url") or "").strip().rstrip("/")
    code = str(body.get("code") or body.get("token") or "").strip()
    frag = urllib.parse.urlparse(url).fragment
    if frag:
        params = urllib.parse.parse_qs(frag, keep_blank_values=True)
        pair = str((params.get("pair") or [""])[0])
        if pair:
            code = pair
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
            "ws": row.get("ws") or "",
            "reused": bool(row.get("reused")),
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


# --- ``/v1/klanker/*`` dashboard surface -------------------------------------
#
# ``klanker serve`` runs the agents-relay HTTP adapter in-process;
# ``install()`` wraps ``TurnHandler`` so the dashboard manages skills,
# routines and memory over the same origin and auth, not only through
# chat turns. ``/v1/hub/*`` and session-switch hooks above are wired
# through the adapter's ``*_fn`` seams; these older routes keep the
# handler-subclass graft.

import shutil  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

from . import __version__  # noqa: E402

_PREFIX = "/v1/klanker"


def _resolve_ws(workspace: str):
    from agents_workspace import Host, Workspace

    if workspace:
        return Host.from_env().workspace(workspace)
    return Workspace.from_env()


def _safe_rel(root: Path, rel: str) -> Path | None:
    target = (root / rel).resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return None
    return target


def _skills_rows(ws) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    root = ws.skills
    if root.is_dir():
        for path in sorted(root.iterdir()):
            if not path.is_dir() or not (path / "SKILL.md").is_file():
                continue
            files = [p for p in path.rglob("*") if p.is_file()]
            rows.append({"name": path.name, "files": len(files), "bytes": sum(p.stat().st_size for p in files)})
    return rows


def _memory_rows(ws, query: str = "") -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    root = ws.memory
    if root.is_dir():
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.suffix not in (".md", ".json"):
                continue
            rel = path.relative_to(root).as_posix()
            if "/.index/" in f"/{rel}" or rel.startswith(".index/"):
                continue
            if query and query.lower() not in rel.lower():
                continue
            rows.append({"path": rel, "bytes": path.stat().st_size})
    return rows


def _routine_rows(ws=None) -> list[dict[str, Any]]:
    from .routine import list_routines

    rows = []
    for job in list_routines(ws):
        rows.append({k: v for k, v in job.items() if not k.startswith("_")})
    return rows


def _load_config(ws) -> dict[str, Any]:
    path = Path(ws.config)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _get(h: Any, path: str, q: dict[str, str]) -> None:
    if path == f"{_PREFIX}/skills":
        ws = _resolve_ws(q.get("workspace", ""))
        h._write_json({"ok": True, "skills": _skills_rows(ws)}, 200)
        return
    if path == f"{_PREFIX}/recall":
        ws = _resolve_ws(q.get("workspace", ""))
        cfg = _load_config(ws)
        recall = cfg.get("recall") if isinstance(cfg.get("recall"), dict) else {}
        h._write_json({"ok": True, "recall": {"enabled": bool(recall.get("enabled"))}}, 200)
        return
    if path == f"{_PREFIX}/routines":
        ws_filter = (q.get("workspace") or "").strip()
        ws = _resolve_ws(ws_filter) if ws_filter else None
        h._write_json({"ok": True, "routines": _routine_rows(ws)}, 200)
        return
    if path == f"{_PREFIX}/memory":
        ws = _resolve_ws(q.get("workspace", ""))
        h._write_json({"ok": True, "files": _memory_rows(ws, q.get("q", ""))}, 200)
        return
    if path == f"{_PREFIX}/memory/file":
        ws = _resolve_ws(q.get("workspace", ""))
        rel = q.get("path", "")
        target = _safe_rel(ws.memory, rel) if rel else None
        if target is None or not target.is_file():
            h.send_error(404, "unknown memory file")
            return
        h._write_json({"ok": True, "path": rel, "content": target.read_text(encoding="utf-8", errors="replace")}, 200)
        return
    h.send_error(404)


def _session_op(h: Any, body: dict, op: str) -> None:
    """POST /v1/klanker/sessions/{checkpoint,prepare} — the spoke side of
    a remote host switch (klanker#155): the old host checkpoints its
    worktree, the new host fetches + materializes it. Admin-only via the
    device gate in _dispatch; the channel RPC rides loopback."""
    import os

    from agents_store.db import connect
    from agents_workspace import Host

    from .session import (
        _git, _git_ok, checkpoint, ensure_worktree, remove_worktree,
        session_branch, session_view)
    from .remote_dispatch import _host_path_for

    sid = str(body.get("session") or body.get("id") or "").strip()
    if not sid:
        h.send_error(400, "session is required")
        return
    host = Host.from_env()
    ws_id = str(body.get("workspace") or os.environ.get(
        "AGENTS_WORKSPACE", "") or "").strip()
    try:
        ws = host.workspace(ws_id) if ws_id else host.select_workspace()
    except Exception:  # noqa: BLE001
        h.send_error(404, "unknown workspace")
        return
    conn = None
    try:
        conn = connect(ws.dir / "store.db", check_same_thread=False)
        view = session_view(conn, sid)
    finally:
        if conn is not None:
            conn.close()
    slug = str(view.get("repo") or "").split(":", 1)[0]
    checkout = _host_path_for(ws, slug) if slug else None
    if checkout is None:
        # no repo recorded/resolved on this host — a pure-conversation
        # session has nothing to checkpoint/prepare
        h._write_json({"ok": True, "skipped": True,
                       "unpushed": False}, 200)
        return
    if op == "checkpoint":
        try:
            hid = str(host.host_id())
        except Exception:  # noqa: BLE001
            hid = ""
        res = checkpoint(checkout, sid, hid)
        h._write_json({"ok": not bool(res.get("error")),
                       **res}, 200)
        return
    if op == "cleanup":
        # orphaned session worktree after a hub-routed switch: the
        # caller only asks once the checkpoint pushed (unpushed work is
        # never stranded); a dirty worktree refuses on git's own check
        res = remove_worktree(checkout, sid)
        h._write_json({"ok": not bool(res.get("error")),
                       **res}, 200)
        return
    # prepare: fetch the session branch (best effort) + ensure worktree
    fetch_err = ""
    branch = str(view.get("branch") or session_branch(sid))
    try:
        remotes = _git(checkout, "remote").stdout.split()
        if remotes:
            remote = "origin" if "origin" in remotes else remotes[0]
            if not _git_ok(checkout, "fetch", remote, branch,
                           timeout=30.0):
                fetch_err = "fetch failed"
    except Exception as exc:  # noqa: BLE001
        fetch_err = str(exc)
    try:
        wt = ensure_worktree(checkout, sid)
    except Exception as exc:  # noqa: BLE001
        h._write_json({"ok": False, "error": str(exc),
                       "fetch_error": fetch_err}, 200)
        return
    h._write_json({"ok": True, "worktree": str(wt),
                   "fetch_error": fetch_err}, 200)


def _post(h: Any, path: str, q: dict[str, str]) -> None:
    body = h._read_json()
    if body is None:
        return
    if path in (f"{_PREFIX}/sessions/checkpoint",
                f"{_PREFIX}/sessions/prepare",
                f"{_PREFIX}/sessions/cleanup"):
        _session_op(h, body, path.rsplit("/", 1)[-1])
        return
    if path == f"{_PREFIX}/recall":
        ws = _resolve_ws(q.get("workspace", "") or str(body.get("workspace") or ""))
        cfg = _load_config(ws)
        recall = cfg.get("recall") if isinstance(cfg.get("recall"), dict) else {}
        recall["enabled"] = bool(body.get("enabled"))
        cfg["recall"] = recall
        target = Path(ws.config)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
        h._write_json({"ok": True, "recall": {"enabled": recall["enabled"]}}, 200)
        return
    if path == f"{_PREFIX}/routines":
        from .routine import add_routine

        try:
            job = add_routine(
                name=str(body.get("name") or ""),
                prompt=str(body.get("prompt") or ""),
                user=str(body.get("user") or "web"),
                at=body.get("at") or None,
                cron=body.get("cron") or None,
                timezone_name=str(body.get("timezone") or ""),
                channel="web",
                workspace=str(body.get("workspace") or ""),
                ws=_resolve_ws(str(body.get("workspace") or ""))
                if str(body.get("workspace") or "").strip()
                else None,
            )
        except ValueError as exc:
            h.send_error(400, str(exc))
            return
        h._write_json({"ok": True, "routine": {k: v for k, v in job.items() if not k.startswith("_")}}, 200)
        return
    if path.startswith(f"{_PREFIX}/routines/"):
        name = path.rsplit("/", 1)[-1]
        from agents_relay.turn import valid_id

        slug = "".join(c for c in name if c.isalnum() or c in "-_")
        if not slug or not valid_id(slug):
            h.send_error(400, f"invalid routine name: {name!r}")
            return
        action = str(body.get("action") or "")
        from .routine import load_routine, pause_routine, perform_routine, remove_routine, resume_routine

        ws_ref = (q.get("workspace") or str(body.get("workspace") or "")).strip()
        ws = _resolve_ws(ws_ref) if ws_ref else None
        try:
            if action == "pause":
                job = pause_routine(slug, ws)
                h._write_json({"ok": True, "routine": {k: v for k, v in job.items() if not k.startswith("_")}}, 200)
                return
            if action == "resume":
                job = resume_routine(slug, ws)
                h._write_json({"ok": True, "routine": {k: v for k, v in job.items() if not k.startswith("_")}}, 200)
                return
            if action == "run":
                result = perform_routine(load_routine(slug, ws), force=True, workspace=ws)
                h._write_json({"ok": True, "result": {k: result.get(k) for k in ("status", "reply", "name")}}, 200)
                return
            if action == "remove":
                if not remove_routine(slug, ws):
                    h.send_error(404, "unknown routine")
                    return
                h._write_json({"ok": True}, 200)
                return
        except (FileNotFoundError, ValueError) as exc:
            h.send_error(404, str(exc))
            return
        h.send_error(400, f"unknown action: {action!r}")
        return
    h.send_error(404)


def _delete(h: Any, path: str, q: dict[str, str]) -> None:
    if path.startswith(f"{_PREFIX}/skills/"):
        name = path.rsplit("/", 1)[-1]
        ws = _resolve_ws(q.get("workspace", ""))
        target = _safe_rel(ws.skills, name)
        if target is None or not target.is_dir() or not (target / "SKILL.md").is_file():
            h.send_error(404, "unknown skill")
            return
        shutil.rmtree(target)
        h._write_json({"ok": True, "skill": name}, 200)
        return
    if path == f"{_PREFIX}/memory/file":
        ws = _resolve_ws(q.get("workspace", ""))
        rel = q.get("path", "")
        target = _safe_rel(ws.memory, rel) if rel else None
        if target is None or not target.is_file():
            h.send_error(404, "unknown memory file")
            return
        target.unlink()
        h._write_json({"ok": True, "path": rel}, 200)
        return
    h.send_error(404)


def _repo_paths(h: Any, method: str, path: str,
                query: dict[str, str]) -> None:
    """``GET``/``PUT /v1/workspaces/<ws>/repo-paths`` — the backend for
    ``<host>/host_paths.json`` (klanker#155; the desktop settings modal
    previously faked this in localStorage).

    Operator surface: admin/cookie callers always; a device token only
    when it names the ws execution.owner — guests never read or write
    host-local checkout paths."""
    from agents_relay.http_adapter import _check_secret

    if not _check_secret(h, h.relay_secret, query):
        h.send_error(401, "unauthorized")
        return
    parts = path.split("/")
    ws_id = parts[3] if len(parts) == 5 else ""
    if not ws_id:
        h.send_error(404)
        return
    from agents_workspace import Host

    host = Host.from_env()
    try:
        ws = host.workspace(ws_id)
    except Exception:  # noqa: BLE001
        h.send_error(404, "unknown workspace")
        return
    ctx = h._auth_ctx() if hasattr(h, "_auth_ctx") else {}
    if ctx.get("kind") == "device":
        owner = str(
            (getattr(ws, "execution", None) or {}).get("owner") or "")
        if not owner or str(ctx.get("device_id") or "") != owner:
            h.send_error(403, "repo-paths is owner/admin only")
            return
    if method == "GET":
        paths = (host.read_host_paths().get(ws_id) or {})
        h._write_json({"ok": True, "workspace": ws_id, "paths": paths},
                      200)
        return
    if method == "PUT":
        body = h._read_json()
        if body is None:
            return
        items = body.get("paths")
        if not isinstance(items, dict):
            # flat {slug: path} bodies are accepted too
            items = {k: v for k, v in body.items()
                     if isinstance(k, str) and isinstance(v, str)
                     and k != "workspace"}
        try:
            for slug, target in items.items():
                host.set_host_repo_path(str(slug), str(target),
                                        ws_id=ws_id)
        except (TypeError, ValueError) as exc:
            h.send_error(400, str(exc))
            return
        paths = (host.read_host_paths().get(ws_id) or {})
        h._write_json({"ok": True, "workspace": ws_id, "paths": paths},
                      200)
        return
    h.send_error(405)


def _dispatch(h: Any, method: str) -> bool:
    """Handle ``/v1/klanker/*`` + ``/v1/workspaces/<ws>/repo-paths``;
    returns True when the request was consumed.

    ``_check_secret`` admits ANY paired device token (revocable channel
    credential) — this surface mints routines, deletes skills/memory and
    flips recall, i.e. operator surface. Device callers of every role
    are denied (klanker#155 C3): a ws_member token must never reach the
    admin graft, and other device roles stay channel-only."""
    from agents_relay.http_adapter import (
        _check_secret, _parse_query, _ws_member_gate)

    path, query = _parse_query(h.path)
    if path.startswith("/v1/workspaces/") \
            and path.rstrip("/").endswith("/repo-paths"):
        _repo_paths(h, method, path.rstrip("/"), query)
        return True
    if not path.startswith(_PREFIX):
        return False
    if not _check_secret(h, h.relay_secret, query):
        h.send_error(401, "unauthorized")
        return True
    ctx = h._auth_ctx() if hasattr(h, "_auth_ctx") else {}
    if ctx.get("kind") == "device":
        if ctx.get("role") == "ws_member":
            reason = _ws_member_gate(
                ctx, method, path, path.split("/"), query)
            if reason:
                h.send_error(403, reason)
                return True
        else:
            h.send_error(403, "device tokens cannot use the admin surface")
            return True
    try:
        if method == "GET":
            _get(h, path, query)
        elif method == "POST":
            _post(h, path, query)
        elif method == "DELETE":
            _delete(h, path, query)
        else:
            h.send_error(405)
    except (KeyError, ValueError) as exc:
        h.send_error(400, str(exc))
    except Exception as exc:
        h.send_error(500, str(exc))
    return True


def handler_class(base: type) -> type:
    """Subclass ``base`` (relay TurnHandler) with klanker mgmt routes."""

    class KlankerMgmtHandler(base):  # type: ignore[misc]
        # /health surfaces this as `klanker_version` (agents-relay reads
        # it off the handler — flat, additive, no auth change).
        klanker_version = __version__

        def do_GET(self) -> None:
            if not _dispatch(self, "GET"):
                super().do_GET()

        def do_POST(self) -> None:
            if not _dispatch(self, "POST"):
                super().do_POST()

        def do_PUT(self) -> None:
            if not _dispatch(self, "PUT"):
                fn = getattr(super(), "do_PUT", None)
                if fn is not None:
                    fn()
                else:
                    self.send_error(501)

        def do_DELETE(self) -> None:
            if not _dispatch(self, "DELETE"):
                super().do_DELETE()

    return KlankerMgmtHandler


def install() -> bool:
    """Graft mgmt routes onto the relay handler; False without agents-relay."""
    try:
        import agents_relay.http_adapter as adapter
    except ImportError:
        return False
    adapter.TurnHandler = handler_class(adapter.TurnHandler)
    return True
