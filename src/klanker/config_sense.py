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

# Same ${ENV_VAR} form as runner.mcp_client.interpolate. Unset names become empty.
_ENV = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def mcp_config_path() -> Path:
    raw = os.environ.get("AGENTS_MCP_CONFIG", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".agents" / "mcp.json"


def skills_dir() -> Path:
    raw = os.environ.get("AGENTS_SKILLS_DIR", "").strip()
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".agents" / "skills"


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


def mcp_report() -> dict[str, Any]:
    path = mcp_config_path()
    if not path.is_file():
        return {"mcp_config": str(path), "mcp_servers": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"mcp_config": str(path), "mcp_servers": [], "mcp_error": str(exc)}
    servers = data.get("mcpServers") if isinstance(data, dict) else None
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
