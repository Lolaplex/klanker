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
_BID_RE = re.compile(r"^bg_[A-Za-z0-9_-]{1,64}$")
_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_MAX_GIT_DIFF_BYTES = 128 * 1024
_MAX_MEMORY_WRITE_BYTES = 1_048_576
_MAX_SKILL_WRITE_BYTES = 524_288


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


def _is_reparse_or_symlink(p: Path) -> bool:
    import os
    import stat

    try:
        st = os.lstat(p)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if stat.S_ISLNK(st.st_mode):
        return True
    attrs = getattr(st, "st_file_attributes", 0)
    return bool(attrs & 0x400)


def _safe_write_rel(root: Path, rel: str) -> tuple[Path | None, int, str]:
    """Confine a relative write/read path under ``root`` without symlink/reparse escape."""
    raw = (rel or "").strip().replace("\\", "/")
    if not raw or "\x00" in raw or "\n" in raw or "\r" in raw:
        return None, 400, "invalid path"
    if raw.startswith("/") or ":" in raw:
        return None, 403, "path escapes root"
    parts = [p for p in raw.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        return None, 403, "path escapes root"
    if root.exists() and _is_reparse_or_symlink(root):
        return None, 403, "symlink root denied"
    cur = root
    for seg in parts:
        cur = cur / seg
        if _is_reparse_or_symlink(cur):
            return None, 403, "symlink/reparse component denied"
    target = cur.resolve()
    try:
        target.relative_to(root.resolve())
    except ValueError:
        return None, 403, "path escapes root"
    return target, 200, ""


def _write_text_atomic(target: Path, text: str) -> int:
    import os
    import tempfile

    data = text.encode("utf-8")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".klanker_", suffix=".tmp", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp_name, target)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return len(data)


def _readonly_error_status(exc: Exception) -> tuple[int, str]:
    msg = str(exc) or "file error"
    code = getattr(exc, "code", 1)
    if code == 2 or any(k in msg for k in ("not a file", "not a directory", "binary file", "invalid path", "invalid pattern", "empty pattern")):
        return 400, msg
    if any(k in msg for k in ("escapes", "permission denied")):
        return 403, msg
    if "not found" in msg:
        return 404, msg
    return 500, msg


def _git_utf8(repo: Path, *args: str, timeout: float = 15.0) -> tuple[int, str, str]:
    import os
    import subprocess

    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
        check=False,
    )
    return proc.returncode, proc.stdout or "", proc.stderr or ""


def _git_diff_bounded(repo: Path, rel_posix: str = "") -> tuple[str, bool]:
    extra = ["--", rel_posix] if rel_posix else []
    rc_head, _, _ = _git_utf8(repo, "rev-parse", "--verify", "HEAD")
    cmd = ["diff", "--no-ext-diff", "--no-textconv"]
    if rc_head == 0:
        cmd.append("HEAD")
    cmd.extend(extra)
    rc, out, _ = _git_utf8(repo, *cmd)
    if rc != 0 and rc_head == 0 and not rel_posix:
        _, out, _ = _git_utf8(repo, "diff", "--no-ext-diff", "--no-textconv")
    raw_bytes = out.encode("utf-8", errors="replace")
    if len(raw_bytes) <= _MAX_GIT_DIFF_BYTES:
        return out, False
    clipped = raw_bytes[:_MAX_GIT_DIFF_BYTES].decode("utf-8", errors="ignore")
    return clipped, True


def _skill_md_path(ws: Any, name: str) -> tuple[Path | None, int, str]:
    if not _SKILL_NAME_RE.fullmatch(name) or name in (".", ".."):
        status = 403 if name in (".", "..") else 400
        return None, status, f"invalid skill name: {name!r}"
    return _safe_write_rel(ws.skills, f"{name}/SKILL.md")


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
    if path.startswith(f"{_PREFIX}/skills/"):
        name = path[len(f"{_PREFIX}/skills/") :]
        ws = _resolve_ws(q.get("workspace", ""))
        target, st, err = _skill_md_path(ws, name)
        if target is None:
            h.send_error(st, err)
            return
        if not target.is_file():
            h.send_error(404, "unknown skill")
            return
        h._write_json(
            {"ok": True, "name": name, "content": target.read_text(encoding="utf-8", errors="replace")},
            200,
        )
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
        target, st, err = _safe_write_rel(ws.memory, rel)
        if target is None:
            h.send_error(st if rel else 404, err or "unknown memory file")
            return
        if not target.is_file():
            h.send_error(404, "unknown memory file")
            return
        h._write_json({"ok": True, "path": rel, "content": target.read_text(encoding="utf-8", errors="replace")}, 200)
        return
    if path == f"{_PREFIX}/doctor":
        from .doctor import collect_checks

        report = collect_checks().to_dict()
        h._write_json({"ok": True, **report}, 200)
        return
    if path == f"{_PREFIX}/stats":
        from agents_traces.stats import compute_stats
        from agents_traces.store import TraceStore

        ws = _resolve_ws(q.get("workspace", ""))
        sid = (q.get("session") or "").strip()
        if sid:
            from .session import InvalidSessionId, validate_session_id

            try:
                sid = validate_session_id(sid)
            except InvalidSessionId as exc:
                h.send_error(400, str(exc))
                return
        days_raw = (q.get("days") or "7").strip()
        try:
            days = max(1, min(365, int(days_raw)))
        except ValueError:
            h.send_error(400, "invalid days")
            return
        store = TraceStore(ws.traces)
        events = store.get_events_for_session(sid) if sid else list(store.iter_events(files=store.list_trace_files(days=days)))
        stats = compute_stats(events)
        h._write_json({"ok": True, "workspace": str(getattr(ws, "id", "") or ""), "stats": stats}, 200)
        return
    if path in (f"{_PREFIX}/files", f"{_PREFIX}/files/read", f"{_PREFIX}/files/grep"):
        from agents_terminal.readonly import ReadonlyError, grep_files, list_directory, read_file

        ws = _resolve_ws(q.get("workspace", ""))
        wd = getattr(ws, "workdir", None)
        if not wd or not Path(wd).is_dir():
            h.send_error(404, "workspace workdir unavailable")
            return
        root = Path(wd).resolve()
        try:
            if path == f"{_PREFIX}/files":
                res = list_directory(root, q.get("path") or ".")
            elif path == f"{_PREFIX}/files/read":
                rel = q.get("path") or ""
                if not rel:
                    h.send_error(400, "path is required")
                    return
                offset = int(q.get("offset") or 1)
                limit = int(q.get("limit") or 2000)
                res = read_file(root, rel, offset=offset, limit=limit)
            else:
                query_txt = q.get("q") or ""
                if not query_txt:
                    h.send_error(400, "q is required")
                    return
                max_m = int(q.get("max_matches") or 200)
                ign = str(q.get("ignore_case") or "").lower() in ("1", "true", "yes")
                res = grep_files(
                    root,
                    query_txt,
                    q.get("path") or ".",
                    glob=q.get("glob") or None,
                    ignore_case=ign,
                    max_matches=max_m,
                )
        except ReadonlyError as exc:
            st, msg = _readonly_error_status(exc)
            h.send_error(st, msg)
            return
        except ValueError:
            h.send_error(400, "invalid numeric parameter")
            return
        h._write_json({"ok": True, **res}, 200)
        return
    if path == f"{_PREFIX}/bg":
        from . import bg

        ws_filter = (q.get("workspace") or "").strip()
        rows = [
            {k: v for k, v in row.items() if k != "log"}
            for row in bg.list_sessions(workspace=ws_filter)
        ]
        h._write_json({"ok": True, "sessions": rows}, 200)
        return
    parts = path.split("/")
    if len(parts) == 6 and parts[1] == "v1" and parts[2] == "klanker" and parts[3] == "bg" and parts[5] == "logs":
        from . import bg

        bid = parts[4]
        if not _BID_RE.fullmatch(bid):
            h.send_error(400, f"invalid bg id: {bid!r}")
            return
        meta = bg.find(bid)
        if not meta:
            h.send_error(404, "unknown bg session")
            return
        try:
            lines = max(1, min(2000, int(q.get("lines") or 200)))
        except ValueError:
            h.send_error(400, "invalid lines")
            return
        h._write_json(
            {"ok": True, "id": bid, "status": meta.get("status"), "logs": bg.log_tail(bid, lines=lines)},
            200,
        )
        return
    if len(parts) == 6 and parts[1] == "v1" and parts[2] == "klanker" and parts[3] == "sessions" and parts[5] == "git":
        from .session import InvalidSessionId, _bound_workdir, _inside_root, session_view, validate_session_id

        sid = parts[4]
        try:
            sid = validate_session_id(sid)
        except InvalidSessionId as exc:
            h.send_error(400, str(exc))
            return
        ws = _resolve_ws(q.get("workspace", ""))
        view: dict[str, Any] = {}
        bound = ""
        try:
            from agents_store import open_db

            if Path(ws.store_db).is_file():
                conn = open_db(ws.store_db)
                try:
                    view = session_view(conn, sid)
                    bound = _bound_workdir(conn, ws, sid)
                finally:
                    conn.close()
        except Exception:
            view = {}
            bound = ""
        target: Path | None = None
        if bound and Path(bound).is_dir() and _inside_root(Path(bound)):
            target = Path(bound).resolve()
        elif getattr(ws, "workdir", None) and Path(ws.workdir).is_dir():
            cand = Path(ws.workdir).resolve()
            rc_git, _, _ = _git_utf8(cand, "rev-parse", "--is-inside-work-tree")
            if rc_git == 0:
                target = cand
        if target is None:
            h._write_json(
                {
                    "ok": True,
                    "is_git": False,
                    "branch": str(view.get("branch") or ""),
                    "repo": str(view.get("repo") or ""),
                    "worktree": "",
                    "dirty_files": [],
                    "wip_unpushed": bool(view.get("wip_unpushed")),
                    "diff": "",
                    "diff_truncated": False,
                },
                200,
            )
            return
        rel_file = (q.get("file") or "").strip()
        rel_posix = ""
        if rel_file:
            from agents_terminal.readonly import ReadonlyError, resolve_path

            try:
                resolved_file = resolve_path(target, rel_file, follow_final=True)
                rel_posix = resolved_file.relative_to(target.resolve()).as_posix()
            except ReadonlyError as exc:
                st, msg = _readonly_error_status(exc)
                h.send_error(st, msg)
                return
            except ValueError:
                h.send_error(403, "path escapes git root")
                return
        rc_b, branch_out, _ = _git_utf8(target, "rev-parse", "--abbrev-ref", "HEAD")
        branch = branch_out.strip() if rc_b == 0 else str(view.get("branch") or "")
        _, status_out, _ = _git_utf8(target, "status", "--porcelain")
        dirty_files = [
            {"status": ln[:2].strip(), "path": ln[3:].strip()}
            for ln in status_out.splitlines()
            if len(ln) >= 4
        ]
        diff_text, diff_truncated = _git_diff_bounded(target, rel_posix)
        h._write_json(
            {
                "ok": True,
                "is_git": True,
                "branch": branch,
                "repo": str(view.get("repo") or ""),
                "worktree": str(target) if bound else "",
                "dirty_files": dirty_files,
                "wip_unpushed": bool(view.get("wip_unpushed")),
                "diff": diff_text,
                "diff_truncated": diff_truncated,
            },
            200,
        )
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
    if path == f"{_PREFIX}/sessions/fork":
        from .fork import fork_session

        ws_ref = (q.get("workspace") or str(body.get("workspace") or "")).strip()
        try:
            ws = _resolve_ws(ws_ref)
        except Exception:
            h.send_error(404, "unknown workspace")
            return
        src = str(body.get("source_session") or body.get("source") or "").strip()
        new_id = str(body.get("new_session") or body.get("new_id") or "").strip()
        if not src:
            h.send_error(400, "source_session is required")
            return
        try:
            sid = fork_session(src, new_id, traces_dir=ws.traces)
        except ValueError as exc:
            msg = str(exc)
            st = 404 if "unknown or empty" in msg else 400
            h.send_error(st, msg)
            return
        h._write_json(
            {"ok": True, "session": sid, "source_session": src, "workspace": str(getattr(ws, "id", "") or "")},
            200,
        )
        return
    parts = path.split("/")
    if len(parts) == 6 and parts[1] == "v1" and parts[2] == "klanker" and parts[3] == "bg" and parts[5] == "kill":
        from . import bg

        bid = parts[4]
        if not _BID_RE.fullmatch(bid):
            h.send_error(400, f"invalid bg id: {bid!r}")
            return
        if not bg.find(bid):
            h.send_error(404, "unknown bg session")
            return
        updated = bg.kill(bid)
        safe_row = {k: v for k, v in updated.items() if k != "log"}
        h._write_json({"ok": True, "session": safe_row}, 200)
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


def _put(h: Any, path: str, q: dict[str, str]) -> None:
    body = h._read_json()
    if body is None:
        return
    if path == f"{_PREFIX}/memory/file":
        ws_ref = (q.get("workspace") or str(body.get("workspace") or "")).strip()
        ws = _resolve_ws(ws_ref)
        rel = str(body.get("path") or q.get("path") or "").strip()
        if not rel:
            h.send_error(400, "path is required")
            return
        content = body.get("content")
        if not isinstance(content, str):
            h.send_error(400, "content must be a string")
            return
        if len(content.encode("utf-8")) > _MAX_MEMORY_WRITE_BYTES:
            h.send_error(413, "memory content too large")
            return
        target, st, err = _safe_write_rel(ws.memory, rel)
        if target is None:
            h.send_error(st, err)
            return
        written = _write_text_atomic(target, content)
        h._write_json({"ok": True, "path": rel, "bytes": written}, 200)
        return
    if path.startswith(f"{_PREFIX}/skills/"):
        name = path[len(f"{_PREFIX}/skills/") :]
        ws_ref = (q.get("workspace") or str(body.get("workspace") or "")).strip()
        ws = _resolve_ws(ws_ref)
        content = body.get("content")
        if not isinstance(content, str):
            h.send_error(400, "content must be a string")
            return
        if len(content.encode("utf-8")) > _MAX_SKILL_WRITE_BYTES:
            h.send_error(413, "skill content too large")
            return
        target, st, err = _skill_md_path(ws, name)
        if target is None:
            h.send_error(st, err)
            return
        written = _write_text_atomic(target, content)
        h._write_json({"ok": True, "name": name, "bytes": written}, 200)
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
        elif method == "PUT":
            _put(h, path, query)
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
