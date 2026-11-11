"""Install Klanker Cordis module overlays into AGENTS_MODULES_DIR."""

from __future__ import annotations

import shutil
from pathlib import Path

from agents_workspace import Workspace

BUNDLED = Path(__file__).resolve().parent / "modules"
OVERLAY_ALWAYS = frozenset({"mcp.schedule.add.json"})
_done: set[Path] = set()


def overlay_dir(workspace: Workspace | None = None) -> Path:
    return (workspace or Workspace.from_env()).modules


def install_overlay(target: Path | None = None, *, generate: bool = True) -> Path:
    dest = target or overlay_dir()
    dest.mkdir(parents=True, exist_ok=True)
    if BUNDLED.is_dir():
        for src in sorted(BUNDLED.glob("*.json")):
            out = dest / src.name
            if src.name in OVERLAY_ALWAYS or not out.exists():
                shutil.copy2(src, out)
    if generate:
        from .helpjson import generate_overlays

        generate_overlays(dest)
    return dest


def ensure_default_overlay(workspace: Workspace | None = None, *, generate: bool = True) -> Path:
    """Install the overlay for ``workspace`` once per process per directory."""
    dest = overlay_dir(workspace)
    if dest in _done:
        return dest
    install_overlay(dest, generate=generate)
    _done.add(dest)
    return dest


def ensure_workspace_overlay(ws: Workspace) -> Path:
    """Install the bundled overlay into one workspace's modules dir."""
    return install_overlay(ws.modules)
