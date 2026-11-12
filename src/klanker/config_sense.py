"""MCP config and skills directory reports for ``klanker sense``."""

from __future__ import annotations

import json
import os
import re
import shutil
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable

from agents_workspace import Host, Workspace

# Same ${ENV_VAR} form as runner.mcp_client.interpolate. Unset names become empty.
_ENV = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def mcp_config_path() -> Path:
    """Host ``mcp.json``. ``AGENTS_MCP_CONFIG_FILE`` wins (alias
    ``AGENTS_MCP_CONFIG``, one release). Same contract as
    ``runner.mcp_client.mcp_config_path``."""
    raw = os.environ.get("AGENTS_MCP_CONFIG_FILE", "").strip()
    if not raw:
        raw = os.environ.get("AGENTS_MCP_CONFIG", "").strip()
        if raw:
            import warnings

            warnings.warn(
                "AGENTS_MCP_CONFIG is deprecated; use AGENTS_MCP_CONFIG_FILE "
                "(alias removed after one release)",
                DeprecationWarning,
                stacklevel=2,
            )
    if raw:
        return Path(raw).expanduser()
    return Host.from_env().mcp_json


def _ws_or_none() -> Workspace | None:
    try:
        return Workspace.from_env()
    except (ValueError, RuntimeError):
        return None


def mcp_overlay_path() -> Path:
    """Optional ``<ws>/mcp.json`` overlay; wins per-server over the host file."""
    ws = _ws_or_none()
    return (ws.root if ws else Host.from_env().dir) / "mcp.json"


def skills_dir() -> Path:
    ws = _ws_or_none()
    return ws.skills if ws else Host.from_env().dir / "skills"


def expand_env(value: Any) -> Any:
    """Expand ``${VAR}`` in strings, lists, and dicts. Missing vars become empty."""
    if isinstance(value, str):
        return _ENV.sub(lambda match: os.environ.get(match.group(1), ""), value)
    if isinstance(value, list):
        return [expand_env(item) for item in value]
    if isinstance(value, dict):
        return {str(key): expand_env(item) for key, item in value.items()}
    return value


def probe_server(
    spec: dict[str, Any],
    *,
    which: Callable[[str], str | None] | None = None,
    open_url: Callable[[str], Any] | None = None,
) -> str:
    """Lightweight health: command on PATH, or URL accepts a connection.

    ``url``, ``command``, ``args``, and ``env`` are expanded like the harness
    before the probe, so a placeholder is not reported as a missing binary.
    """
    if not isinstance(spec, dict):
        return "invalid"
    spec = expand_env(spec)
    url = str(spec.get("url") or "").strip()
    if url:
        return _probe_url(url, open_url=open_url)
    command = str(spec.get("command") or "").strip()
    if not command:
        return "invalid"
    finder = which or shutil.which
    if finder(command) or Path(command).expanduser().is_file():
        return "ok"
    return "missing-command"


def _probe_url(url: str, *, open_url: Callable[[str], Any] | None) -> str:
    if open_url is not None:
        try:
            open_url(url)
            return "ok"
        except Exception:
            return "unreachable"
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            return "ok" if int(resp.status) < 500 else "unreachable"
    except urllib.error.HTTPError as exc:
        return "ok" if int(exc.code) < 500 else "unreachable"
    except Exception:
        return "unreachable"


def _mcp_servers(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    return servers if isinstance(servers, dict) else {}


def mcp_report() -> dict[str, Any]:
    path = mcp_config_path()
    overlay = mcp_overlay_path()
    if not path.is_file() and not overlay.is_file():
        return {"mcp_config": str(path), "mcp_servers": []}
    servers = _mcp_servers(path) if path.is_file() else {}
    if overlay.is_file():
        servers = {**servers, **_mcp_servers(overlay)}
    rows: list[dict[str, str]] = []
    if isinstance(servers, dict):
        for name, spec in servers.items():
            body = spec if isinstance(spec, dict) else {}
            transport = "http" if body.get("url") else "stdio"
            rows.append(
                {
                    "name": str(name),
                    "transport": transport,
                    "health": probe_server(body),
                }
            )
    return {"mcp_config": str(path), "mcp_servers": rows}


def skills_report() -> dict[str, Any]:
    root = skills_dir()
    names: list[str] = []
    if root.is_dir():
        for path in sorted(root.iterdir()):
            if path.is_dir() and (path / "SKILL.md").is_file():
                names.append(path.name)
    return {"skills_dir": str(root), "skills": names}
