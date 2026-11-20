"""Klanker-owned ``/v1/klanker/*`` management routes, grafted onto the relay.

``klanker serve`` runs the agents-relay HTTP adapter in-process; ``install()``
wraps ``TurnHandler`` so the dashboard manages skills, routines and memory over
the same origin and auth, not only through chat turns.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

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


def _routine_rows() -> list[dict[str, Any]]:
    from .routine import list_routines

    rows = []
    for job in list_routines():
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
        h._write_json({"ok": True, "routines": _routine_rows()}, 200)
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


def _post(h: Any, path: str, q: dict[str, str]) -> None:
    body = h._read_json()
    if body is None:
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

        try:
            if action == "pause":
                job = pause_routine(slug)
                h._write_json({"ok": True, "routine": {k: v for k, v in job.items() if not k.startswith("_")}}, 200)
                return
            if action == "resume":
                job = resume_routine(slug)
                h._write_json({"ok": True, "routine": {k: v for k, v in job.items() if not k.startswith("_")}}, 200)
                return
            if action == "run":
                result = perform_routine(load_routine(slug), force=True)
                h._write_json({"ok": True, "result": {k: result.get(k) for k in ("status", "reply", "name")}}, 200)
                return
            if action == "remove":
                if not remove_routine(slug):
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


def _dispatch(h: Any, method: str) -> bool:
    """Handle ``/v1/klanker/*``; returns True when the request was consumed."""
    from agents_relay.http_adapter import _check_secret, _parse_query

    path, query = _parse_query(h.path)
    if not path.startswith(_PREFIX):
        return False
    if not _check_secret(h, h.relay_secret, query):
        h.send_error(401, "unauthorized")
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
        def do_GET(self) -> None:
            if not _dispatch(self, "GET"):
                super().do_GET()

        def do_POST(self) -> None:
            if not _dispatch(self, "POST"):
                super().do_POST()

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
